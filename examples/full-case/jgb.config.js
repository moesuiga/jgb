const Path = require('path')

module.exports = {
  // entryFiles: ['pages/index/index.json'],
  // entryFiles: ['assets/index.wxss'],
  entryFiles: ['app.ts', 'app.wxss', 'app.json'],
  // entryFiles: ['pages/weapp/weapp.ts'],
  cache: false,
  alias: {
    '@/components': './src/components',
    '@components': './components/',
    // 'lodash': 'lodash-es',
    '@/utils': './src/utils',
    "@/src": './src',
    '@alias': './aliasTest',
    '@alias-test': Path.resolve('../alias-test/src/'),
    '@navbar': {
      path: './node_modules/miniprogram-navigation-bar',
      dist: 'pages/aliasComponent/'
    }
  },
  presets: ['weapp'],
  plugins: [['less', {
    extensions: ['.wxss'],
    outExt: '.wxss'
  }], 'typescript']
}
