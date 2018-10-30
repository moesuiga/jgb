import * as fs from 'fs-extra';
import * as _ from 'lodash';
import * as path from 'path';
import * as URL from 'url';
import { IInitOptions } from '../typings/jgb-shared';
import * as config from './config';
import { logger } from './Logger';
import { ICompiler } from './pluginDeclare';
import Resolver from './Resolver';
import SourceMap from './SourceMap';
import { normalizeAlias, promoteRelativePath } from './utils';
import { pathToUnixType } from './utils/index';
import isUrl from './utils/isUrl';
import objectHash from './utils/objectHash';
import WorkerFarm from './workerfarm/WorkerFarm';

const DEFAULT_NPM_DIR = 'npm';

const REG_NODE_MODULES = /(\/node_modules\/|\/npm\/)/g;

const cache = new Map<string, string>();

export interface IAssetGenerate {
  code: string;
  ext: string;
  map?: SourceMap;
}

export default class Asset {
  id: string;
  dependencies = new Map<string, any>();
  contents = '';
  basename: string;
  relativeName: string;
  resolver: Resolver;
  ast: any;
  processed = false;
  generated: IAssetGenerate | IAssetGenerate[] = null;
  hash: string;
  // tslint:disable-next-line:variable-name
  _package: any;

  startTime: any;
  endTime: any;
  cacheData: any = {};

  distPath: string;
  /** 某些插件会自动注入compiler */
  parentCompiler: ICompiler;

  constructor(public name: string, public options: IInitOptions) {
    this.basename = path.basename(name);
    this.relativeName = path.relative(options.sourceDir, name);
    const resolver = WorkerFarm.getSharedResolver();
    this.resolver = resolver || new Resolver(options);
  }

  invalidate() {
    this.processed = false;
    this.contents = null;
    this.ast = null;
    this.generated = null;
    this.hash = null;
    this.dependencies.clear();
    // this.depAssets.clear();
  }

  /**
   * 判断是否需要 invalidate 资源
   */
  shouldInvalidate(cacheData?: any) {
    return false;
  }

  /**
   * 解析引用资源aliasName
   * 根据当前文件
   * @param name
   */
  async resolveAliasName(name: string, ext: string = '') {
    /** resolve relative path */
    const { path: absolutePath } = (await this.resolver.resolve(
      name,
      this.name
    )) as {
      path: string;
      pkg: any;
    };

    /** require相对引用路径 */
    let relativeRequirePath = '';

    const distPath = this.generateDistPath(absolutePath, ext);
    const parentDistPath = this.generateDistPath(this.name, ext);

    if (distPath && parentDistPath) {
      relativeRequirePath = promoteRelativePath(
        path.relative(parentDistPath, distPath)
      );
    }

    return {
      /* 文件真实路径 */
      realName: absolutePath,
      distPath,
      absolutePath,
      /* require相对路径 */
      relativeRequirePath
    };
  }

  addDependency(name: string, opts: any = {}) {
    this.dependencies.set(name, Object.assign({ name }, opts));
  }

  addURLDependency(url: string, from = this.name, opts?: any) {
    if (!url || isUrl(url)) {
      return url;
    }

    if (typeof from === 'object') {
      opts = from;
      from = this.name;
    }

    const parsed = URL.parse(url);
    let depName;
    let resolved;
    let dir = path.dirname(from);
    let filename = decodeURIComponent(parsed.pathname);

    if (filename[0] === '~' || filename[0] === '/') {
      if (dir === '.') {
        dir = this.options.rootDir;
      }
      // 绝对定位默认是相对于 sourceDir而言
      // 当文件不在source目录中时
      // 绝对目录应该相对于文件所在项目package.json位置或者是package.json所指向的main文件所在位置
      if (filename[0] === '/' && !this.name.includes(this.options.sourceDir)) {
        const pkg = this.resolver.findPackageSync(dir);
        if (pkg) {
          let root = pkg.pkgdir;
          // pkg.main like dist/index.js
          if (pkg.main && pkg.main.includes('/')) {
            const distDir = pkg.main.split(/\\|\//g)[0];
            root = path.join(root, distDir);
          }

          filename = promoteRelativePath(
            path.relative(this.name, path.join(root, filename))
          );
        }
      }
      depName = resolved = this.resolver.resolveFilename(filename, dir);
    } else {
      resolved = path.resolve(dir, filename);
      depName = './' + path.relative(path.dirname(this.name), resolved);
    }

    if (path.isAbsolute(depName)) {
      depName = promoteRelativePath(path.relative(this.name, depName));
    }

    this.addDependency(depName, Object.assign({ dynamic: true }, opts));

    // parsed.pathname = this.options.parser.getAsset(resolved, this.options);

    parsed.pathname = depName;

    return URL.format(parsed);
  }

  /**
   * 处理资源
   * 1. load
   * 2. pretransform
   * 3. getDependencies
   * 4. transform
   * 5. generate
   * 6. output
   */
  async process() {
    if (!this.id) {
      this.id = this.relativeName;
    }

    const startTime = +new Date();

    await this.loadIfNeeded();
    await this.pretransform();
    await this.getDependencies();
    await this.transform();
    this.generated = await this.generate();
    const generated: IAssetGenerate[] = [].concat(this.generated);
    for (const { code, ext, map } of generated) {
      this.hash = await this.generateHash();
      const { distPath, ignore } = await this.output(code, ext, map);
      const endTime = +new Date();

      if (!ignore) {
        logger.log(`${distPath}`, '编译', endTime - startTime);
      }
    }

    // logger.log(`编译 ${this.name}`);
  }

  async loadIfNeeded() {
    if (!this.contents) {
      this.contents = (await this.load()) || '';
    }
  }

  // tslint:disable-next-line:no-empty
  async pretransform() {}

  // tslint:disable-next-line:no-empty
  async transform() {}

  // tslint:disable-next-line:no-empty
  async postProcess(generated: any): Promise<any> {}

  /**
   * 获取当前资源的依赖资源
   */
  async getDependencies() {
    await this.loadIfNeeded();

    if (this.contents && this.mightHaveDependencies()) {
      await this.parseIfNeeded();
      await this.collectDependencies();
    }
  }

  async parseIfNeeded() {
    await this.loadIfNeeded();
    if (!this.ast) {
      this.ast = await this.parse(this.contents);
    }
  }

  async collectDependencies() {
    console.log('Asset.collectDependencies must be overload');
  }

  mightHaveDependencies() {
    return true;
  }

  /**
   * 生成文件dist路径
   */
  generateDistPath(sourcePath: string, ext: string = '') {
    if (cache.has(sourcePath)) {
      return cache.get(sourcePath);
    }

    const alias = this.options.alias;
    const sourceDir = path.resolve(this.options.sourceDir);
    const name = pathToUnixType(sourcePath);
    let distPath = '';

    const aliasDirs = [...Object.entries(alias)];

    while (aliasDirs.length) {
      const [aliasName, aliasValue] = aliasDirs.shift();
      const normalizedAlias = normalizeAlias(aliasValue);
      const dir = normalizedAlias.path;
      const distDir = normalizedAlias.dist
        ? normalizedAlias.dist
        : DEFAULT_NPM_DIR;
      // in alias source dir but not in build source file
      if (name.includes(sourceDir)) {
        const relatePath = path.relative(sourceDir, name);
        distPath = path.join(this.options.outDir, relatePath);
        break;
      }
      if (name.includes(dir)) {
        // 相对于alias目录的相对路径
        const relativeAlias = path.relative(dir, name);

        distPath = path.join(
          this.options.outDir,
          distDir,
          aliasName as string,
          relativeAlias
        );
        break;
      }
    }

    // fix style
    distPath = pathToUnixType(distPath);

    /**
     * node_modules/npm => npm
     */
    if (
      (!distPath && name.match(REG_NODE_MODULES)) ||
      distPath.match(REG_NODE_MODULES)
    ) {
      const spNM = name.split(REG_NODE_MODULES);
      const relativeAlias = spNM.pop();
      distPath = path.join(this.options.outDir, DEFAULT_NPM_DIR, relativeAlias);
    }

    if (!distPath) {
      const relatePath = path.relative(sourceDir, name);
      distPath = path.join(this.options.outDir, relatePath);
    }

    const extName = path.extname(distPath);

    if (!extName) {
      // index => index.js
      distPath += ext;
    } else if (ext && extName && extName !== ext) {
      // index.es6 => index.js
      distPath = distPath.replace(extName, ext);
    }

    cache.set(sourcePath, distPath);
    return distPath;
  }

  /**
   * 生成输出目录distPath
   * @param code
   * @param ext
   */
  async output(
    code: string,
    ext: string = '',
    map: SourceMap
  ): Promise<{
    distPath: string;
    ignore: boolean;
  }> {
    /* 是否忽略编译 */
    let ignore = true;

    let distPath =
      this.distPath ||
      this.generateDistPath(this.name, ext) ||
      path.resolve(this.options.outDir, this.relativeName);

    let prettyDistPath = this.distPath;
    const extName = path.extname(this.basename);

    if (!ext && !path.extname(distPath)) {
      // index => index.js
      distPath += ext;
    } else if (extName !== ext) {
      // index.es6 => index.js
      distPath = distPath.replace(extName, ext);
    }

    this.distPath = distPath;

    prettyDistPath = promoteRelativePath(
      path.relative(this.options.outDir, distPath)
    );

    // if distPath not in outDir
    if (!prettyDistPath.startsWith('..')) {
      ignore = false;
      const sourceMapString = map
        ? map.stringify(path.basename(prettyDistPath), '/')
        : '';
      if (sourceMapString) {
        await writeFile(
          distPath,
          code +
            `\r\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(
              sourceMapString,
              'utf-8'
            ).toString('base64')}`
        );
      } else {
        await writeFile(distPath, code);
      }
    }

    return {
      ignore,
      distPath: prettyDistPath
    };
  }

  async generateHash() {
    return objectHash(this.generated);
  }

  /**
   * 加载资源
   */
  async load() {
    return await fs.readFile(this.name, 'utf-8');
  }

  /**
   * 解析资源
   * @param contents
   */
  async parse(contents: string): Promise<any> {
    console.log('Asset.parse must be overload');
  }

  async generate(): Promise<IAssetGenerate | IAssetGenerate[]> {
    // console.log('Asset.generate must be overload');
    return {
      code: '',
      ext: ''
    };
  }

  async getPackage() {
    if (!this._package) {
      this._package = await this.resolver.findPackage(path.dirname(this.name));
    }

    return this._package;
  }

  async getConfig(filenames: string[], opts: any = {}) {
    if (opts.packageKey) {
      const pkg = await this.getPackage();
      if (pkg && pkg[opts.packageKey]) {
        return _.cloneDeep(pkg[opts.packageKey]);
      }
    }

    // Resolve the config file
    const conf = await config.resolve(opts.path || this.name, filenames);
    if (conf) {
      // Add as a dependency so it is added to the watcher and invalidates
      // this asset when the config changes.
      await this.addDependency(conf, { includedInParent: true });
      if (opts.load === false) {
        return conf;
      }

      return await config.load(opts.path || this.name, filenames);
    }

    return null;
  }
}

async function writeFile(filePath: string, code: string) {
  await fs.ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, code);
}
