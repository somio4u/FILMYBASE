// "Where your files are stored": connect a Google account, see which account
// is connected, create / open the project's folder, test, disconnect.
//
// The Google password is typed on Google's own page (opened by the Connect
// button) and never reaches this app. After you press Allow, Google sends
// you back here and the app can write to your Drive.
import { useCallback, useEffect, useRef, useState } from 'react'

const RETURN_KEY = 'filmybase:driveReturn'

const RETURN_REASONS = {
  denied: 'You cancelled the Google sign-in, so nothing was connected.',
  expired: 'That sign-in link expired or was already used. Press Connect with Google again.',
  token: 'Google did not accept the sign-in. The server’s Google credentials may be wrong. Check GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET, then try again.',
  no_refresh: 'Google did not give lasting access. Open myaccount.google.com/permissions, remove this app, then press Connect again.',
  unknown: 'The Google sign-in did not finish. Try again.',
}

export default function DriveCard({ projectId, backendUrl }) {
  const api = `${backendUrl}/api/production`
  const [status, setStatus] = useState(null)
  const [folder, setFolder] = useState(null)
  const [message, setMessage] = useState(null) // { tone: 'ok' | 'bad' | 'info', text }
  const [busy, setBusy] = useState(null) // 'test' | 'prepare' | 'disconnect'
  const [testResult, setTestResult] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const [s, f] = await Promise.all([
        fetch(`${api}/storage/status`).then((r) => (r.ok ? r.json() : null)),
        fetch(`${api}/${projectId}/storage/folder`).then((r) => (r.ok ? r.json() : null)),
      ])
      setStatus(s)
      setFolder(f)
      return { s, f }
    } catch {
      setMessage({ tone: 'bad', text: 'Could not check where files are stored. Check your connection.' })
      return {}
    }
  }, [api, projectId])

  async function createFolder() {
    setBusy('prepare')
    try {
      const response = await fetch(`${api}/${projectId}/storage/prepare`, { method: 'POST' })
      const data = await response.json()
      if (!response.ok || data.ok === false) setMessage({ tone: 'bad', text: data.message || data.error || 'Could not create the folder.' })
      else setMessage({ tone: 'ok', text: `The folder “${data.folderName}” is ready in your Google Drive, with its sections inside.` })
      await refresh()
    } catch {
      setMessage({ tone: 'bad', text: 'Could not reach the server.' })
    }
    setBusy(null)
  }

  // Back from Google's login page: say what happened; on success create the folder.
  // (handledReturn: the note is acted on exactly once, even when the page runs
  // this effect twice in development.)
  const handledReturn = useRef(false)
  useEffect(() => {
    async function start() {
      const { s } = await refresh()
      if (handledReturn.current) return
      let returned = null
      try { returned = sessionStorage.getItem(RETURN_KEY) } catch { /* private mode */ }
      if (!returned) return
      handledReturn.current = true
      try { sessionStorage.removeItem(RETURN_KEY) } catch { /* private mode */ }
      if (returned === 'connected' && s?.driveConnected) {
        setMessage({ tone: 'ok', text: `Connected${s.account?.emailAddress ? ` as ${s.account.emailAddress}` : ''}. Creating your project folder…` })
        await createFolder()
      } else if (returned === 'connected') {
        setMessage({ tone: 'bad', text: 'Google said yes, but the app could not use the connection yet. Press Test connection to see why.' })
      } else {
        const reason = returned.startsWith('error:') ? returned.slice(6) : 'unknown'
        setMessage({ tone: 'bad', text: RETURN_REASONS[reason] ?? RETURN_REASONS.unknown })
      }
    }
    start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  async function runTest() {
    setBusy('test')
    setTestResult(null)
    try {
      const response = await fetch(`${api}/storage/test`, { method: 'POST' })
      setTestResult(await response.json())
    } catch {
      setTestResult({ ok: false, message: 'Could not reach the server.' })
    }
    setBusy(null)
  }

  async function disconnect() {
    if (!window.confirm('Disconnect Google Drive? Files already in Drive stay there, but this app cannot open them until you connect the same Google account again.')) return
    setBusy('disconnect')
    try {
      await fetch(`${api}/drive/disconnect`, { method: 'POST' })
      setTestResult(null)
      setMessage({ tone: 'info', text: 'Disconnected. Your files in Google Drive were not touched.' })
      await refresh()
    } catch {
      setMessage({ tone: 'bad', text: 'Could not reach the server.' })
    }
    setBusy(null)
  }

  if (!status) return <section className="drive-card" aria-label="File storage"><p className="dossier-fine-print">Checking where files are stored…</p></section>

  const connectUrl = `${api}/drive/connect`
  const isDrive = status.backend === 'gdrive'

  return (
    <section className="drive-card" aria-label="File storage">
      <h3>Where your files are stored</h3>

      {!isDrive && (
        <p>
          This server stores files in its own folder{status.warning ? '' : '.'} {status.warning && <span className="dossier-bad">{status.warning}</span>}
          <span className="dossier-fine-print"> Google Drive is used automatically on Render.</span>
        </p>
      )}

      {isDrive && !status.configured && (
        <div className="dossier-message" role="alert">
          <strong>Google sign-in is not set up on the server yet.</strong>
          <p className="dossier-fine-print">
            An admin must add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the server, switch on the Google Drive API in Google Cloud Console,
            and register this redirect address: <code>{status.setup.redirectUri}</code>. Then reload this page.
          </p>
        </div>
      )}

      {isDrive && status.configured && !status.driveConnected && (
        <div>
          {status.reconnectNeeded && (
            <p className="dossier-bad" role="alert">Google no longer accepts the saved sign-in (it may have expired or been removed). Connect again to continue.</p>
          )}
          <p>Every image, audio and video you make is saved to <strong>your own Google Drive</strong>, in a folder named after the project.</p>
          <a className="choose-button drive-connect-button" href={connectUrl}>Connect with Google</a>
          <p className="dossier-fine-print">
            Google’s own sign-in page opens. Choose your Google account and enter your password there, then press Allow.
            The app never sees your password, and it can only see the files and folders it creates.
          </p>
        </div>
      )}

      {isDrive && status.configured && status.driveConnected && (
        <div>
          <p>
            <span className="dossier-ok">Connected</span> to Google Drive
            {status.account ? <> as <strong>{status.account.displayName ? `${status.account.displayName} · ` : ''}{status.account.emailAddress}</strong></> : null}.
          </p>
          <div className="drive-actions">
            <button type="button" className="dossier-small-button" disabled={busy !== null} onClick={runTest}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
            <a className="dossier-small-button drive-link-button" href={connectUrl}>Use a different Google account</a>
            <button type="button" className="dossier-small-button" disabled={busy !== null} onClick={disconnect}>Disconnect</button>
          </div>
        </div>
      )}

      {folder && (isDrive ? status.driveConnected : true) && (
        <div className="drive-folder">
          <p>
            Project folder: <strong>{folder.folderName}</strong>{' '}
            {folder.link ? (
              <a className="dossier-link" href={folder.link} target="_blank" rel="noreferrer">Open in Google Drive</a>
            ) : (
              <button type="button" className="dossier-small-button" disabled={busy !== null} onClick={createFolder}>
                {busy === 'prepare' ? 'Creating…' : isDrive ? 'Create the folder in Drive now' : 'Create the folders now'}
              </button>
            )}
          </p>
          <details>
            <summary>How the folder is arranged</summary>
            <ul className="drive-layout">
              <li><strong>{folder.folderName}</strong>
                <ul>{folder.layout.map((name) => <li key={name}>{name}</li>)}</ul>
              </li>
            </ul>
            <p className="dossier-fine-print">Characters, props and environments each get their own sub-folder named with their code, for example “CHAR001 Rahul Mohapatra”. Renaming the project renames this folder.</p>
          </details>
        </div>
      )}

      {message && <p className={message.tone === 'bad' ? 'dossier-bad' : message.tone === 'ok' ? 'dossier-ok' : 'dossier-fine-print'} role="status">{message.text}</p>}
      {testResult && (
        <p className={testResult.ok ? 'dossier-ok' : 'dossier-bad'} role="status">
          {testResult.ok ? 'Test passed: a small file was saved, read back and removed. Your Drive works.' : testResult.message}
        </p>
      )}
      {status.files && Object.keys(status.files).length > 0 && (
        <p className="dossier-fine-print">
          Files so far: {status.files.stored ?? 0} stored{status.files.pending_upload ? ` · ${status.files.pending_upload} waiting to upload` : ''}{status.files.failed ? ` · ${status.files.failed} failed` : ''}
        </p>
      )}
    </section>
  )
}
