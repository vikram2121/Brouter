#!/usr/bin/env node
// Entry point router — reads SERVICE env var to pick the right dist file
const service = process.env.SERVICE || 'web';
if (service === 'worker') {
  require('./dist/worker.js');
} else if (service === 'oracle') {
  require('./dist/oracle.js');
} else {
  require('./dist/index.js');
}
