const { resolve } = require("path");

// One bundle per job. Acurast requires a single self-contained .js file per
// deployment, so each job gets its own webpack entry → its own dist/<job>.bundle.js.
module.exports = {
  entry: {
    fetcher: "./src/jobs/fetcher.ts",
    classifier: "./src/jobs/classifier.ts",
    settler: "./src/jobs/settler.ts",
    repricer: "./src/jobs/repricer.ts",
  },
  mode: "production",
  output: {
    filename: "[name].bundle.js",
    path: resolve(__dirname, "dist"),
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        use: "ts-loader",
        exclude: /node_modules/,
      },
    ],
  },
  resolve: {
    extensions: [".ts", ".js"],
  },
  target: "node",
  // Acurast processors run a modern Node — keep the bundle Promise/fetch-friendly.
  optimization: {
    minimize: true,
  },
};
