#!/usr/local/bin/node
import { program, Option } from "commander";
import { cwd } from "process";
import fg from 'fast-glob';
import fs from 'fs';
import { join, dirname, resolve } from "path";
import semver from 'semver';


program
    .addOption(new Option('--root <path>', "Working directory").default(cwd()))
    .addOption(new Option('--verbose <value>', 'Set verbose level').choices(['0', '1', '2', '3', '4', '5']).default('2'))
    .action(async () => {
        const options = program.opts();

        const files = await fg(['**/package.json'], {
            cwd: options.root,
            ignore: ['**/node_modules/**', 'package.json']
        });

        const packages = files.map(x => join(options.root, x)).map(x => new Package(x));

        const g = new Graph<Package>();

        for (let pkg of packages) {
            pkg.addDependenciesFrom(packages);

            g.addVertex(pkg);
        }

        const sorted = packages.sort((a, b) => b.links - a.links);

        for (let pkg of sorted) {
            for (let dep of pkg.refs) {
                g.addEdge(pkg, dep);
            }
        }

        const mostUsed = sorted[0];

        const orderedByGraph: Package[] = [];
        g.dfs(mostUsed, v => orderedByGraph.push(v));
        // check loops. Fail if any

        // console.log(sorted.map(x => `${x.name}, ${x.links}`));
        // console.log(orderedByGraph.map(x => `${x.name}, ${x.links}`));

        await Promise.all(orderedByGraph.map(proj => proj.ensureLinks()));
    })
    .parse()

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
        peerDependencies: Record<string, string>
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

    private async getStatSafe(fullPath: string): Promise<fs.Stats | null> {
        try {
            return await fs.promises.stat(fullPath);
        }
        catch {
            return null;
        }
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
        let list = this._vertices; // список смежности
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
        stack = [...this._vertices.keys()];

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

