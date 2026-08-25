/**
 * Entry point for `npm test`. Runs every provider suite in one Electron
 * process and exits non-zero if any check fails.
 */
import { app } from 'electron'

import { runS3Suite } from './s3.test'
import { runSftpSuite } from './sftp.test'

app.whenReady().then(() => {
  void (async () => {
    let failures = 0
    try {
      failures += await runSftpSuite()
      failures += await runS3Suite()
    } catch (err) {
      console.error('\nHARNESS ERROR:', err)
      app.exit(2)
      return
    }

    console.log(
      failures === 0 ? '\nALL SUITES PASSED\n' : `\n${failures} CHECK(S) FAILED ACROSS SUITES\n`
    )
    app.exit(failures === 0 ? 0 : 1)
  })()
})
