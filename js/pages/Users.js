// ============================================================================
// VIBRANT CashFlow — User Management (Admin only)
// ============================================================================

function UsersPage({ user, settings, reloadSettings }) {
  const [users, setUsers] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [modal, setModal] = React.useState(null); // 'add' | {edit:user} | {resetPw:user}
  const [confirmDelete, setConfirmDelete] = React.useState(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try { setUsers(await DataStore.getUsers()); }
    catch (err) { console.error(err); Toast.error(DataStore.describeError(err, 'Could not load users.')); }
    finally { setLoading(false); }
  }, []);
  React.useEffect(() => { load(); }, [load]);

  async function updateLockDays(val) {
    const parsed = Number(val);
    if (!Number.isInteger(parsed) || parsed < 0 || parsed > 3650) {
      Toast.error('Lock days must be a whole number from 0 to 3650.');
      return false;
    }
    try {
      const s = { ...settings, editLockDays: parsed };
      await DataStore.saveSettings(s);
      await reloadSettings();
      Toast.success('Setting updated.');
      return true;
    } catch (err) {
      console.error(err); Toast.error(DataStore.describeError(err, 'Could not update the setting.')); return false;
    }
  }

  async function toggleActive(u) {
    if (u.id === user.id && u.active) { Toast.error('You cannot deactivate your own account.'); return; }
    const activeAdmins = users.filter((item) => item.active && item.role === ROLES.ADMIN);
    if (u.active && u.role === ROLES.ADMIN && activeAdmins.length <= 1) { Toast.error('At least one active Administrator is required.'); return; }
    try {
      await DataStore.upsertUser({ ...u, active: !u.active });
      Toast.success(u.active ? 'User deactivated.' : 'User activated.');
      await load();
    } catch (err) { console.error(err); Toast.error(DataStore.describeError(err, 'Could not update that user.')); }
  }

  async function removeUser(id) {
    if (id === user.id) { Toast.error('You cannot delete your own account.'); setConfirmDelete(null); return; }
    const target = users.find((item) => item.id === id);
    const activeAdmins = users.filter((item) => item.active && item.role === ROLES.ADMIN);
    if (target && target.active && target.role === ROLES.ADMIN && activeAdmins.length <= 1) {
      Toast.error('At least one active Administrator is required.'); setConfirmDelete(null); return;
    }
    try {
      await DataStore.deleteUser(id);
      setConfirmDelete(null);
      Toast.success('App access removed.');
      await load();
    } catch (err) { console.error(err); Toast.error(DataStore.describeError(err, 'Could not remove that user\'s access.')); }
  }

  if (loading) return <PageLoader />;

  return (
    <div>
      <div className="toolbar">
        <div className="spacer" />
        <button className="btn btn-secondary" onClick={() => setModal('settings')}>⚙️ Settings</button>
        <button className="btn btn-primary" onClick={() => setModal('add')}>+ Add User</button>
      </div>

      <div className="table-wrap">
        <table className="dtable">
          <thead><tr><th>Name</th><th>Username</th><th>Role</th><th>Status</th><th></th></tr></thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <td>{u.name}</td>
                <td className="cell-muted">{u.username}</td>
                <td><Badge tone="primary">{ROLE_LABELS[u.role] || u.role}</Badge></td>
                <td>{u.active ? <Badge tone="success">Active</Badge> : <Badge tone="neutral">Inactive</Badge>}</td>
                <td style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <button className="btn btn-ghost btn-sm" onClick={() => setModal({ edit: u })}>Edit</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setModal({ resetPw: u })}>Send Password Reset</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => toggleActive(u)} disabled={u.id === user.id && u.active}>{u.active ? 'Deactivate' : 'Activate'}</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDelete(u)}>Remove Access</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {modal === 'settings' && (
        <SettingsModal settings={settings} onClose={() => setModal(null)} onSave={updateLockDays} />
      )}

      {modal && modal !== 'settings' && (
        <UserFormModal
          mode={modal === 'add' ? 'add' : modal.edit ? 'edit' : 'resetPw'}
          existing={modal === 'add' ? null : modal.edit || modal.resetPw}
          users={users}
          currentUserId={user.id}
          onClose={() => setModal(null)}
          onDone={() => { setModal(null); load(); }}
        />
      )}

      {confirmDelete && (
        <ConfirmModal title="Remove app access" tone="danger" confirmLabel="Remove Access"
          message={`Remove CashFlow access for "${confirmDelete.name}" (${confirmDelete.username})? Their Firebase Authentication account is not deleted; remove it separately in Firebase Console if required.`}
          onCancel={() => setConfirmDelete(null)} onConfirm={() => removeUser(confirmDelete.id)} />
      )}
    </div>
  );
}

function SettingsModal({ settings, onClose, onSave }) {
  const [days, setDays] = React.useState((settings && settings.editLockDays) ?? 7);
  const [busy, setBusy] = React.useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      if (await onSave(days)) onClose();
    } finally { setBusy(false); }
  }

  return (
    <Modal title="Access Settings" onClose={onClose} footer={
      <React.Fragment><button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? <span className="spinner on-dark"></span> : 'Save'}</button></React.Fragment>
    }>
      <form onSubmit={submit}>
        <div className="field" style={{ marginBottom: 0 }}>
          <label>Categorization edit lock (days)</label>
          <input aria-label="Categorization edit lock in days" className="input" required type="number" min="0" max="3650" step="1" value={days} onChange={(e) => setDays(e.target.value)} autoFocus />
          <p className="help-text">Back Office cannot edit or categorize transactions older than this many days. Admin is never restricted.</p>
        </div>
      </form>
    </Modal>
  );
}

function UserFormModal({ mode, existing, users, currentUserId, onClose, onDone }) {
  const [name, setName] = React.useState(existing ? existing.name : '');
  const [username, setUsername] = React.useState(existing ? existing.username : '');
  const [role, setRole] = React.useState(existing ? existing.role : ROLES.BACKOFFICE);
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  async function submit(e) {
    e.preventDefault();
    if (mode === 'resetPw') {
      setBusy(true);
      try {
        await Auth.sendFirebasePasswordReset(existing.username);
        Toast.success('Password reset email sent.');
        onClose();
      } catch (err) { console.error(err); Toast.error(DataStore.describeError(err, 'Could not send the password reset email.')); }
      finally { setBusy(false); }
      return;
    }
    if (!name.trim() || !username.trim()) { Toast.error('Name and email are required.'); return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(username.trim())) { Toast.error('Enter a valid email address.'); return; }
    const dup = users.find((u) => u.username.toLowerCase() === username.trim().toLowerCase() && (!existing || u.id !== existing.id));
    if (dup) { Toast.error('That username is already taken.'); return; }
    if (mode === 'add' && (!password || password.length < 8)) { Toast.error('Set a password of at least 8 characters.'); return; }
    if (existing && existing.id === currentUserId && role !== existing.role) {
      Toast.error('You cannot change your own role. Ask another Administrator.'); return;
    }
    const activeAdmins = users.filter((u) => u.active && u.role === ROLES.ADMIN);
    if (existing && existing.active && existing.role === ROLES.ADMIN && role !== ROLES.ADMIN && activeAdmins.length <= 1) {
      Toast.error('At least one active Administrator is required.'); return;
    }

    setBusy(true);
    try {
      if (mode === 'add') {
        const id = await Auth.createFirebaseUser(username.trim(), password);
        await DataStore.upsertUser({
          id, name: name.trim(), username: username.trim(), role, active: true,
          createdAt: Utils.todayISO(),
        });
      } else {
        await DataStore.upsertUser({ ...existing, name: name.trim(), username: username.trim(), role });
      }
      Toast.success('Saved.');
      onDone();
    } catch (err) { console.error(err); Toast.error(DataStore.describeError(err, 'Could not save that user.')); }
    finally { setBusy(false); }
  }

  const title = mode === 'add' ? 'Add User' : mode === 'edit' ? 'Edit User' : `Send Password Reset — ${existing.name}`;

  return (
    <Modal title={title} onClose={onClose} footer={
      <React.Fragment><button className="btn btn-secondary" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={submit} disabled={busy}>{busy ? <span className="spinner on-dark"></span> : (mode === 'resetPw' ? 'Send Reset Email' : 'Save')}</button></React.Fragment>
    }>
      <form onSubmit={submit}>
        {mode !== 'resetPw' && (
          <React.Fragment>
            <div className="field"><label>Full Name</label><input aria-label="Full Name" className="input" required value={name} onChange={(e) => setName(e.target.value)} autoFocus /></div>
            <div className="field"><label>Email</label><input aria-label="Email" type="email" className="input" required autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} disabled={mode === 'edit'} /></div>
            {mode === 'edit' && <p className="help-text">Login email is managed in Firebase Authentication and cannot be changed from this screen.</p>}
            <div className="field"><label>Role</label>
              <Tabs ariaLabel="Role" disabled={existing && existing.id === currentUserId} items={[{ value: ROLES.ADMIN, label: 'Admin' }, { value: ROLES.BACKOFFICE, label: 'Back Office' }, { value: ROLES.VIEWER, label: 'Viewer' }]} value={role} onChange={setRole} />
            </div>
          </React.Fragment>
        )}
        {mode === 'add' && (
          <div className="field"><label>Password</label><input aria-label="Password" className="input" required minLength="8" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
        )}
        {mode === 'resetPw' && <p className="help-text">A secure Firebase password-reset link will be emailed to {existing.username}.</p>}
      </form>
    </Modal>
  );
}
