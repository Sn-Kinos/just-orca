// Puts an evidence file on the clipboard (README.md, 증거 파일). osascript gets its arguments as an
// array; nothing goes through a shell. The path comes from evidenceFile, never from the panel.
import { execFile } from 'node:child_process'

// Writes the file URL itself, as Finder's Copy does, so a paste attaches or copies the file.
const COPY_SCRIPT = [
  'function run(argv) {',
  "ObjC.import('AppKit');",
  'const board = $.NSPasteboard.generalPasteboard;',
  'board.clearContents;',
  "return board.writeObjects($.NSArray.arrayWithObject($.NSURL.fileURLWithPath(argv[0]))) ? 'ok' : 'failed'",
  '}'
].join(' ')

export function copyFile(osascript: string, path: string): Promise<void> {
  return new Promise((resolve, reject) =>
    execFile(osascript, ['-l', 'JavaScript', '-e', COPY_SCRIPT, path], (err, stdout, stderr) => {
      const out = String(stdout).trim()
      if (err) reject(new Error(String(stderr).trim() || err.message))
      else if (out !== 'ok') reject(Object.assign(new Error(`클립보드에 넣지 못했습니다: ${out}`), { code: 'action_failed' }))
      else resolve()
    })
  )
}
