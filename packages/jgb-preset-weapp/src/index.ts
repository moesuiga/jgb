import * as glob from 'fast-glob';
import BabelPlugin from 'jgb-plugin-babel';
import CssPlugin from 'jgb-plugin-css';
import HtmlPlugin from 'jgb-plugin-html';
import JsonPlugin from 'jgb-plugin-json';
import JsonAsset from 'jgb-plugin-json/lib/JsonAsset';
import { declare, IInitOptions } from 'jgb-shared/lib';
import { ICompiler } from 'jgb-shared/lib/pluginDeclare';
import * as Path from 'path';
import { pathToUnixType } from '../../jgb-shared/lib/utils';

interface IPluginConfig {
  coreOptions?: IInitOptions;
}

interface IAppTabBar {
  color: string;
  selectedColor: string;
  backgroundColor: string;
  borderStyle: string;
  list: IAppJsonTabarListConfg[];
  position: string;
}

interface IAppJson {
  pages: string[];
  tabBar: IAppTabBar;
  subPackages: Array<{
    root: string;
    pages: string[];
  }>;
}

interface IAppJsonTabarListConfg {
  pagePath: string;
  text: string;
  iconPath: string;
  selectedIconPath: string;
}

interface IPageJson {
  usingComponents: {
    [componentName: string]: string;
  };
}

export default declare((compiler, pluginConfig: IPluginConfig = {}) => {
  if (pluginConfig && pluginConfig.coreOptions) {
    const entryFiles = []
      .concat(pluginConfig.coreOptions.entryFiles)
      .filter(Boolean);
    if (entryFiles.length === 0) {
      entryFiles.push('app.js', 'app.json', 'app.wxss');

      pluginConfig.coreOptions.entryFiles = entryFiles;
    }
  }

  attachCompilerEvent(compiler);

  BabelPlugin(compiler, {});
  JsonPlugin(compiler, {});
  HtmlPlugin(compiler, {
    extensions: ['.wxml'],
    outExt: '.wxml'
  });

  CssPlugin(compiler, {
    extensions: ['.wxss'],
    outExt: '.wxss'
  });
});

function attachCompilerEvent(compiler: ICompiler) {
  compiler.on('collect-app-json', collectAppJson);
  compiler.on('collect-page-json', collectPageJson);
}

async function collectPageJson({
  dependences,
  pageJson,
  ctx
}: {
  dependences: Set<string>;
  pageJson: IPageJson;
  ctx: JsonAsset;
}) {
  // 是否使用组件
  if (
    !pageJson.usingComponents ||
    typeof pageJson.usingComponents !== 'object'
  ) {
    return;
  }
  const extensions = ctx.options.parser.extensions as Map<string, any>;
  const supportExtensions = extensions.keys();
  const components: string[] = [];

  for (const [key, value] of Object.entries(pageJson.usingComponents)) {
    // not relative path
    if (value.indexOf('.') === -1) {
      // alias path
      const {
        distPath,
        relativeRequirePath,
        realName,
        absolutePath
      } = await ctx.resolveAliasName(value);
      if (distPath && relativeRequirePath) {
        const relativeRequire = relativeRequirePath.replace(/\.(\w)+/, '');
        pageJson.usingComponents[key] = relativeRequire;
        if (realName) {
          // alias
          const componentPath = pathToUnixType(absolutePath.replace(/\.(\w)+/, ''))
          components.push(componentPath);
        }

        if (absolutePath.includes('node_modules')) {
          // npm
          const result = await findPackage(Path.dirname(absolutePath));
          if (!result) {
            continue;
          }
          const { pkg, dir } = result;
          // 如果配置了miniprogram小程序组件目录 会copy整个目录
          if (pkg.miniprogram) {
            const npmProjectDir = Path.join(dir, pkg.miniprogram);

            const allMatches = await glob.async(['**/**'], {
              cwd: npmProjectDir
            });
            if (allMatches) {
              allMatches.forEach((file: string) => {
                dependences.add(Path.join(npmProjectDir, file));
              });
            }
          } else {
            // only resolve
            components.push(absolutePath.replace(/\.(\w)+/, ''));
          }
        }
        continue;
      }
    }

    components.push(value);
  }

  // expandFiles
  if (components.length > 0) {
    for (const dep of await ctx.expandFiles(
      new Set(components),
      supportExtensions
    )) {
      dependences.add(dep);
    }
  }

  async function findPackage(dir: string) {
    // Find the nearest package.json file within the current node_modules folder
    const root = Path.parse(dir).root;
    while (dir !== root && Path.basename(dir) !== 'node_modules') {
      try {
        const pkg = await ctx.resolver.findPackage(dir);
        return {
          dir,
          pkg
        };
      } catch (err) {
        // ignore
      }

      dir = Path.dirname(dir);
    }
  }
}

async function collectAppJson({
  dependences,
  appJson,
  ctx
}: {
  dependences: Set<string>;
  appJson: IAppJson;
  ctx: JsonAsset;
}) {
  const extensions = ctx.options.parser.extensions as Map<string, any>;
  const supportExtensions = extensions.keys();
  const assetPaths: string[] = [];

  // pages asset
  if (Array.isArray(appJson.pages)) {
    assetPaths.push(...appJson.pages);
  }

  // subPackages asset
  if (Array.isArray(appJson.subPackages)) {
    // tslint:disable-next-line:no-shadowed-variable
    appJson.subPackages.forEach(({ root, pages }) => {
      const subPackagePages = pages.map(page => Path.join(root, page));
      assetPaths.push(...subPackagePages);
    });
  }

  // expandFiles
  if (Array.isArray(assetPaths)) {
    for (const dep of await ctx.expandFiles(
      new Set(assetPaths),
      supportExtensions
    )) {
      dependences.add(dep);
    }
  }

  // tabBar asset
  if (appJson.tabBar && Array.isArray(appJson.tabBar.list)) {
    appJson.tabBar.list.forEach(config => {
      // tslint:disable-next-line:no-unused-expression
      config.iconPath && dependences.add(config.iconPath);
      // tslint:disable-next-line:no-unused-expression
      config.selectedIconPath && dependences.add(config.selectedIconPath);
    });
  }
}
