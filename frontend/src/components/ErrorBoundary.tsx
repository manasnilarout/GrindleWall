import { Component, type ErrorInfo, type ReactNode } from 'react';
import { Icon, PanelIcon } from './Icon';

/**
 * Without this, one throwing component renders a blank page and the only clue
 * is in the devtools console. This is a bench tool that gets edited a lot, so
 * failures should be visible where you are looking.
 */
interface Props {
  children: ReactNode;
  /**
   * Scopes the failure to one panel instead of the whole page, so a bad session
   * record cannot take the rest of the bench down with it.
   */
  panel?: string;
}

export class ErrorBoundary extends Component<Props, { error?: Error }> {
  state: { error?: Error } = {};

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI crashed:', error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.panel) {
      return (
        <section className="panel">
          <h2>
            <PanelIcon name="lightning" />
            {this.props.panel}
          </h2>
          <div className="banner error">
            <strong>This panel crashed.</strong>
            <pre style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0' }}>{error.message}</pre>
          </div>
          <button type="button" className="ghost" onClick={() => this.setState({})}>
            <Icon name="refresh" size={12} />
            Retry
          </button>
        </section>
      );
    }

    return (
      <div className="app">
        <div className="banner error">
          <strong>The UI crashed.</strong>
          <pre style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0' }}>{error.message}</pre>
        </div>
        <button type="button" className="btn primary" onClick={() => this.setState({})}>
          <Icon name="refresh" size={12} />
          Retry render
        </button>
      </div>
    );
  }
}
