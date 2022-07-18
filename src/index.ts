#!/usr/local/bin/node
import { program, Option, Command, Argument } from "commander";
import { cwd } from "process";
import fg from 'fast-glob';
import fs from 'fs';
import { join, dirname, resolve } from "path";
import shelljs from 'shelljs';
const { exec, which } = shelljs;

function getRootFolder(): string {
    const options = program.opts();

    return options.root || cwd();
}

async function getPackages() {
    const cwd = getRootFolder();

    const files = await fg(['**/package.json'], {
        cwd,
        ignore: ['**/node_modules/**', 'package.json']
    });

    const packages = files.map(x => join(cwd, x)).map(x => new Package(x));
    return packages;
}

const runCommand = new Command('run')
    .addArgument(new Argument('<command>', 'command to be run on each project'))
    .option('--async', 'Run tasks in parallel', false)
    .action(async (command: string, options: { async: boolean }) => {
        const packages = await getPackages();

        if (options.async) {
            await Promise.all(packages.map(x => x.tryRunScript(command)));
        }
        else {
            for (let pkg of packages) {
                await pkg.tryRunScript(command);
            }
        }
    });
const linkCommand = new Command('link')
    .action(async () => {
        const packages = await getPackages();
        //const g = new Graph<Package>();

        for (let pkg of packages) {
            pkg.addDependenciesFrom(packages);

            // g.addVertex(pkg);
        }

        // const sorted = packages.sort((a, b) => b.links - a.links);

        // for (let pkg of sorted) {
        //     for (let dep of pkg.refs) {
        //         g.addEdge(pkg, dep);
        //     }
        // }

        // const mostUsed = sorted[0];

        // const orderedByGraph: Package[] = [];
        // g.dfs(mostUsed, v => orderedByGraph.push(v));
        // check loops. Fail if any

        // console.log(sorted.map(x => `${x.name}, ${x.links}`));
        // console.log(orderedByGraph.map(x => `${x.name}, ${x.links}`));
        // await Promise.all(orderedByGraph.map(proj => proj.ensureLinks()));
        await Promise.all(packages.map(proj => proj.ensureLinks()));
    });

const installDependencies = new Command('install-deps')
    .option('--async', 'Run tasks in parallel', false)
    .action(async (options: { async: boolean }) => {
        const packages = await getPackages();

        if (options.async) {
            await Promise.all(packages.map(x => x.ensureDependencies()));
        }
        else {
            for (let pkg of packages) {
                console.log('>>> Installing dependencies for ', pkg.name);
                await pkg.ensureDependencies();
            }
        }

        if (packages.some(x => x.hasPeerDependencies)) {
            const cwd = getRootFolder();
            const rootPackageFile = join(cwd, "package.json");

            const p = new Package(rootPackageFile);
            console.log('>>> Installing root dependencies for ', p.name);
            await p.ensureDependencies();
        }
    });

program
    .addOption(new Option('--root <path>', "Working directory").default(cwd()))
    .addCommand(runCommand)
    .addCommand(linkCommand)
    .addCommand(installDependencies)
    .addHelpCommand()
    .action(async () => program.help())
    .parse();

function onlyUnique<T>(value: T, index: number, self: T[]) {
    return self.indexOf(value) === index;
}

function getDepsArr(obj?: Record<string, string>): string[] {
    if (!obj) {
        return [];
    }

    return Object.getOwnPropertyNames(obj);
}


export class Package {
    private readonly _fi: {
        name: string,
        version: string,
        dependencies: Record<string, string>,
        devDependencies: Record<string, string>,
        peerDependencies: Record<string, string>,
        scripts: Record<string, string>
    };
    private _deps: string[];
    private _refs: Package[] = [];
    private _links: number = 0;
    private readonly _path: string;

    /**
     *
     */
    constructor(
        filePath: string
    ) {
        const fileInfo = fs.readFileSync(filePath, 'utf8');

        this._path = resolve(dirname(filePath));

        this._fi = JSON.parse(fileInfo);

        //console.log("INFO", this._fi.name, `@`, this._fi.version, this.path);

        this._deps = [...getDepsArr(this._fi.dependencies), ...getDepsArr(this._fi.devDependencies), ...getDepsArr(this._fi.peerDependencies)].filter(onlyUnique);
    }

    get path() { return this._path; }

    get name() { return this._fi.name; }
    get version() { return this._fi.version; }
    get allDependencies() { return this._deps; }
    get refs() { return this._refs; }

    get links() { return this._links; }

    get hasPeerDependencies() { return Object.getOwnPropertyNames(this._fi.peerDependencies ?? {}).length > 0; }

    private async getStatSafe(fullPath: string): Promise<fs.Stats | null> {
        try {
            return await fs.promises.stat(fullPath);
        }
        catch {
            return null;
        }
    }

    async ensureDependencies() {
        return new Promise<boolean>(async (resolve, reject) => {
            const cwd = this.path;
            const yarnLock = join(cwd, 'yarn.lock');
            const yarnLockStat = await this.getStatSafe(yarnLock);
            let command = 'npm install';
            if (yarnLockStat?.isFile()) {
                if (!which('yarn')) {
                    reject('Yarn is not installed');
                    return;
                }

                command = 'yarn';
            }

            exec(`${command} --force`, { cwd }, (code: number) => {
                if (code === 0) {
                    resolve(true);
                }
                else {
                    reject(code);
                }
            });
        });
    }

    async ensureLinks() {
        const nodeModules = join(this.path, 'node_modules');
        const stat = await this.getStatSafe(nodeModules);
        if (!stat?.isDirectory()) {
            await fs.promises.mkdir(nodeModules);
        }

        for (let dep of this._refs) {
            const target = join(nodeModules, dep.name);

            try {
                await fs.promises.mkdir(target, { recursive: true });
            }
            catch { }

            try {
                await fs.promises.rm(target, { recursive: true, force: true });
            }
            catch (e) {
                console.warn(e);
            }

            console.log('[', this.name, '] Adding link to ', dep.name);
            await fs.promises.symlink(dep.path, target);
        }
    }

    addDependenciesFrom(packages: Package[]) {
        const refs = packages.filter(p => this._deps.includes(p.name));

        for (const ref of refs) {
            ref._links++;
        }

        this._refs = refs;
    }

    tryRunScript(command: string) {
        return new Promise<boolean>(async (resolve, reject) => {
            const commandToExecute = this._fi.scripts?.[command];

            if (!commandToExecute) {
                resolve(false);
                return;
            }

            const cwd = this.path;

            console.log(`Running command "${command}" on ${this.name}...`);

            exec(`npm run ${command}`, { cwd }, (code: number) => {
                if (code === 0) {
                    resolve(true);
                }
                else {
                    reject(code);
                }
            });
        });
    }
}

class Graph<T> {
    private readonly _vertices: Map<T, T[]> = new Map();

    constructor() {
    }

    addVertex(value: T) {
        if (!this._vertices.has(value)) {
            this._vertices.set(value, []);
        }
    }

    addEdge(vertex1: T, vertex2: T) {
        if (!this._vertices.has(vertex1) || !this._vertices.has(vertex2)) {
            throw new Error('В графе нет таких вершин');
        }

        if (!this._vertices.get(vertex1)!.includes(vertex2)) {
            this._vertices.get(vertex1)!.push(vertex2);
        }
        if (!this._vertices.get(vertex2)!.includes(vertex1)) {
            this._vertices.get(vertex2)!.push(vertex1);
        }
    }

    dfs(startVertex: T, callback?: (vertex: T) => void) {
        const list = this._vertices; // список смежности
        let stack = [startVertex]; // стек вершин для перебора
        const visited: T[] = [startVertex];

        function handleVertex(vertex: T) {
            // вызываем коллбэк для посещенной вершины
            callback?.(vertex);

            // получаем список смежных вершин
            let reversedNeighboursList = [...list.get(vertex)!].reverse();

            reversedNeighboursList.forEach(neighbour => {
                if (!visited.includes(neighbour)) {
                    // отмечаем вершину как посещенную
                    visited.push(neighbour);
                    // добавляем в стек
                    stack.push(neighbour);
                }
            });
        }

        // перебираем вершины из стека, пока он не опустеет
        while (stack.length) {
            let activeVertex = stack.pop()!;
            handleVertex(activeVertex);
        }

        // проверка на изолированные фрагменты
        stack.length = 0;
        stack.push(...this._vertices.keys());

        while (stack.length) {
            let activeVertex = stack.pop()!;
            if (!visited.includes(activeVertex)) {
                visited.push(activeVertex);
                handleVertex(activeVertex);
            }
        }
    }

    bfs(startVertex: T, callback?: (vertex: T) => void) {
        const list = this._vertices; // список смежности
        let queue = [startVertex]; // очередь вершин для перебора
        const visited = [startVertex]; // посещенные вершины

        function handleVertex(vertex: T) {
            // вызываем коллбэк для посещенной вершины
            callback?.(vertex);

            // получаем список смежных вершин
            const neighboursList = list.get(vertex)!;

            neighboursList.forEach(neighbour => {
                if (!visited.includes(neighbour)) {
                    visited.push(neighbour);
                    queue.push(neighbour);
                }
            });
        }

        // перебираем вершины из очереди, пока она не опустеет
        while (queue.length) {
            let activeVertex = queue.shift();
            handleVertex(activeVertex!);
        }

        queue = [...this._vertices.keys()];

        // Повторяем цикл для незатронутых вершин
        while (queue.length) {
            let activeVertex = queue.shift()!;
            if (!visited.includes(activeVertex)) {
                visited.push(activeVertex);
                handleVertex(activeVertex);
            }
        }
    }
}

