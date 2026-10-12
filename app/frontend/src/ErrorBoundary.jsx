import { Component } from 'react'

// If any part of the screen crashes while drawing, show a calm message with a way back
// instead of a blank white page. `inline` keeps the rest of the app usable.
export default class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null } }
  static getDerivedStateFromError(error) { return { error } }
  componentDidCatch(error, info) { try { console.error('Screen crashed:', error, info?.componentStack) } catch { /* ignore */ } }
  render() {
    if (!this.state.error) return this.props.children
    const close = () => { this.setState({ error: null }); this.props.onClose?.() }
    return (
      <div role="alert" style={{ position: this.props.inline ? 'relative' : 'fixed', inset: this.props.inline ? 'auto' : 0, zIndex: 100000, display: 'grid', placeItems: 'center', padding: 16, background: this.props.inline ? 'transparent' : '#0b1020', color: '#e8ecff', font: '16px system-ui, sans-serif', textAlign: 'center' }}>
        <div style={{ maxWidth: 420 }}>
          <h2 style={{ margin: '0 0 8px' }}>Something went wrong on this screen</h2>
          <p style={{ margin: '0 0 16px', opacity: 0.85 }}>Your work is saved. Nothing was deleted.</p>
          <button type="button" onClick={close} style={{ padding: '10px 18px', borderRadius: 10, border: 0, background: '#6d5cff', color: '#fff', fontSize: 16, marginRight: 8 }}>{this.props.onClose ? 'Close this' : 'Try again'}</button>
          {!this.props.inline && <button type="button" onClick={() => window.location.reload()} style={{ padding: '10px 18px', borderRadius: 10, border: '1px solid #6d5cff', background: 'transparent', color: '#e8ecff', fontSize: 16 }}>Reload</button>}
        </div>
      </div>
    )
  }
}
