const fs = require('fs')
const path = require('path')

// Append-only JSON-lines audit trail of session metadata.
// Never log media, SDP, ICE candidates or tokens here.
function createAudit({ dir, retentionDays, sink } = {}) {
  if (dir) {
    fs.mkdirSync(dir, { recursive: true })
    prune()
  }

  function fileFor(date) {
    return path.join(dir, `audit-${date.toISOString().slice(0, 10)}.jsonl`)
  }

  function prune() {
    if (!dir || !retentionDays) return
    const cutoff = Date.now() - retentionDays * 86400000
    for (const name of fs.readdirSync(dir)) {
      const match = /^audit-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)
      if (match && Date.parse(match[1]) < cutoff) fs.unlinkSync(path.join(dir, name))
    }
  }

  function log(event, fields = {}) {
    const now = new Date()
    const entry = { ts: now.toISOString(), event, ...fields }
    if (sink) sink(entry)
    if (dir) {
      fs.appendFile(fileFor(now), JSON.stringify(entry) + '\n', err => {
        if (err) console.error('[audit] write failed', err)
      })
    }
  }

  return { log, prune }
}

module.exports = { createAudit }
