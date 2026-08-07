const path = require('path');

const rootConfig = {
  mode: 'development',
  optimization: {
    usedExports: true,
  },
  devtool: 'eval-source-map',
};

const appConfig = {
  ...rootConfig,
  entry: './src/index.js',
  output: {
    filename: 'main.js',
    path: path.resolve(__dirname, 'public/scripts'),
    publicPath: '/scripts/',
  },
};

const serviceWorkerConfig = {
  ...rootConfig,
  entry: './src/firebase-messaging-sw.js',
  module: {
    rules: [
      {
        test: /\.m?js/,
        resolve: {
          fullySpecified: false,
        },
      },
    ],
  },
  output: {
    filename: 'firebase-messaging-sw.js',
    path: path.resolve(__dirname, 'public'),
  },
};

module.exports = (env, argv) => {
  const isDevServer = process.env.WEBPACK_SERVE === 'true';

  if (isDevServer) {
    appConfig.devServer = {
      static: {
        directory: path.resolve(__dirname, 'public'),
      },
      port: 8080,
      hot: true,
      liveReload: true,
      historyApiFallback: {
        index: '/index.html',
      },
      client: {
        overlay: {
          errors: true,
          warnings: false,
        },
      },
    };
  }

  return [appConfig, serviceWorkerConfig];
};
