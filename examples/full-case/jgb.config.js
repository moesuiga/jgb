const Path = require('path')

module.exports = {
  // entryFiles: ['app.js'],
  // entryFiles: ['pages/weapp/weapp.ts'],
  // entryFiles: ['pages/aliasComponent/index.json'],
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
