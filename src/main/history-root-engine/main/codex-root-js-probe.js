'use strict';

// Node 18 public API. A subscriber sees the real active registers at their
// allocation/use boundaries. Production does not retain probe events.
const channel = require('node:diagnostics_channel').channel('noted.history.paged-js');
function probe(phase, arena, value) {
  if (channel.hasSubscribers) channel.publish({ phase, arena, value });
}
module.exports = { probe };
