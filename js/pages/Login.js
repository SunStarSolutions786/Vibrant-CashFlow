// ============================================================================
// VIBRANT CashFlow — Login page
// ============================================================================

function LoginPage({ onLoggedIn }) {
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [error, setError] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function submit(e) {
    e.preventDefault();
    setError('');
    if (!username || !password) { setError(`Enter your ${USE_FIREBASE ? 'email' : 'username'} and password.`); return; }
    setBusy(true);
    try {
      const res = await Auth.login(username, password);
      if (!res.ok) { setError(res.error); return; }
      onLoggedIn(res.user);
    } catch (err) {
      console.error(err);
      setError('Sign in failed. Please try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="login-screen">
      <div className="login-card slide-up">
        <div className="login-brand">
          <BrandLogo className="login-brand-logo" />
          <h1>{APP_NAME}</h1>
          <p>{APP_TAGLINE}</p>
        </div>

        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="login-username">{USE_FIREBASE ? 'Email' : 'Username'}</label>
            <input id="login-username" className="input" type={USE_FIREBASE ? 'email' : 'text'} required value={username} onChange={(e) => setUsername(e.target.value)} placeholder={USE_FIREBASE ? 'name@company.com' : 'Enter your username'} autoComplete="username" autoFocus />
          </div>
          <div className="field">
            <label htmlFor="login-password">Password</label>
            <input id="login-password" className="input" type="password" required value={password} onChange={(e) => setPassword(e.target.value)} placeholder="Enter your password" autoComplete="current-password" />
          </div>
          {error && <div className="error-text" role="alert" style={{ marginBottom: 14 }}>{error}</div>}
          <button className="btn btn-primary btn-block" type="submit" disabled={busy} aria-busy={busy}>
            {busy ? <React.Fragment><span className="spinner on-dark" aria-hidden="true"></span><span className="visually-hidden">Signing in…</span></React.Fragment> : 'Sign in'}
          </button>
        </form>

        <p className="help-text" style={{ textAlign: 'center', marginTop: 18 }}>
          Access is provisioned by your administrator.
        </p>
      </div>
    </div>
  );
}
