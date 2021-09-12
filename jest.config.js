const {jest: jestConfig} = require('kcd-scripts/config')

module.exports = Object.assign(jestConfig, {
  coverageThreshold: {
    ...jestConfig.coverageThreshold,
    // full coverage across the build matrix (React 17, 18) but not in a single job
    './src/pure': {
      // minimum coverage of jobs using React 17 and 18
      branches: 80,
      functions: 78,
      lines: 84,
      statements: 84,
    },
  },
})
