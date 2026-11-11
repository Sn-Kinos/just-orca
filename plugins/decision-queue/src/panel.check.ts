// `orca plugin check` renders the panel once per scenario with the real worker on a fresh host.
// The queue scenario points at test/fixtures (invented items); it types into no terminal and opens nothing.
import { defineCheck } from 'orca/testing'

const fixtures = new URL('../test/fixtures/decisions', import.meta.url).pathname

export default defineCheck({
  fresh: {},
  queue: {
    storage: { config: { dir: fixtures, handleFile: '/nonexistent/handle', open: 'none' }, notified: [] },
    results: { 'notifications.show': { delivered: true }, 'statusBar.update': { ok: true }, 'terminal.sendText': { accepted: false } }
  }
})
