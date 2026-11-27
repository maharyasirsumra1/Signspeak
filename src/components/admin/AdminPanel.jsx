import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  BarChart3,
  Bell,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  CircleUserRound,
  Clock3,
  Database,
  FileClock,
  Fingerprint,
  LayoutDashboard,
  LogOut,
  Network,
  Search,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  Smartphone,
  Trash2,
  Users,
  Video
} from 'lucide-react';
import SignSpeakFlowers from '../SignSpeakFlowers.jsx';
import SignSpeakLoginBackground from '../SignSpeakLoginBackground.jsx';
import '../SignSpeakLogin.css';
import './AdminPanel.css';

const PAGE_SIZE = 25;

const NAV_ITEMS = [
  { id: 'overview', label: 'Overview Dashboard', icon: LayoutDashboard, permission: 'reports.read' },
  { id: 'users', label: 'All Users', icon: Users, permission: 'users.read' },
  { id: 'active', label: 'Active Users', icon: CircleUserRound, permission: 'users.read' },
  { id: 'login-history', label: 'Login History', icon: FileClock, permission: 'logs.auth.read' },
  { id: 'registration-history', label: 'Registration History', icon: CalendarDays, permission: 'logs.auth.read' },
  { id: 'activity', label: 'User Activity', icon: Activity, permission: 'logs.activity.read' },
  { id: 'usage', label: 'SignSpeak Usage', icon: BarChart3, permission: 'reports.read' },
  { id: 'contacts', label: 'Contact Management', icon: Network, permission: 'users.read' },
  { id: 'call-devices', label: 'Approved Call Devices', icon: Smartphone, superAdmin: true },
  { id: 'calls', label: 'Call Activity', icon: Video, permission: 'reports.read' },
  { id: 'sessions', label: 'Active Sessions', icon: Fingerprint, permission: 'sessions.read' },
  { id: 'suspended', label: 'Suspended Accounts', icon: ShieldAlert, permission: 'users.read' },
  { id: 'deleted', label: 'Deleted Accounts', icon: Trash2, permission: 'users.read' },
  { id: 'audit', label: 'Admin Audit Logs', icon: ShieldCheck, permission: 'audit.read' },
  { id: 'admins', label: 'Admin Management', icon: Shield, superAdmin: true },
  { id: 'permissions', label: 'Roles & Permissions', icon: ShieldCheck, superAdmin: true },
  { id: 'reports', label: 'Reports & Analytics', icon: BarChart3, permission: 'reports.read' },
  { id: 'security', label: 'Security Settings', icon: ShieldAlert, permission: 'reports.read' },
  { id: 'system', label: 'System Settings', icon: Settings, permission: 'reports.read' },
  { id: 'profile', label: 'Admin Profile', icon: CircleUserRound }
];

const PAGE_TITLES = Object.fromEntries(NAV_ITEMS.map(({ id, label }) => [id, label]));

export function AdminLogin({ onSubmit, error, busy }) {
  return (
    <main className="auth-screen">
      <div className="auth-page">
        <aside className="login-sidebar" aria-label="SignSpeak Admin">
          <span>SignSpeak</span>
        </aside>

        <SignSpeakLoginBackground />

        <form
          onSubmit={onSubmit}
          aria-labelledby="admin-auth-heading"
          className="login-card admin-login-card"
        >
          <p className="admin-login-eyebrow">SECURE ADMIN CONSOLE</p>
          <h1 id="admin-auth-heading" className="login-title">Admin Login</h1>
          <label className="admin-login-label">
            Administrator email or username
            <input
              className="login-field"
              name="email"
              type="text"
              placeholder="Email or username"
              aria-label="Administrator email or username"
              autoComplete="username"
              maxLength={254}
              required
            />
          </label>
          <label className="admin-login-label">
            Password
            <input
              className="login-field"
              name="password"
              type="password"
              placeholder="Password"
              aria-label="Administrator password"
              autoComplete="current-password"
              maxLength={128}
              required
            />
          </label>
          {error && <p className="login-error" role="alert">{error}</p>}
          <button className="login-btn" type="submit" disabled={busy}>
            {busy ? 'PLEASE WAIT…' : 'ADMIN LOGIN'}
          </button>
          <p className="login-member">
            <a className="admin-login-user-link" href="/">Back to SignSpeak</a>
          </p>
          <p className="admin-login-setup">
            First time? Create an account with your chosen email and password, verify the email, then set that address as <code>SUPER_ADMIN_EMAIL</code> in the server .env file and restart SignSpeak. There is no shared default admin password.
          </p>
        </form>

        <SignSpeakFlowers />
      </div>
    </main>
  );
}

export default function AdminPanel({ user, apiRequest, onProfileUpdated, onLogout }) {
  const isSuperAdmin = user.role === 'super_admin';
  const [activePage, setActivePage] = useState(isSuperAdmin ? 'overview' : 'users');
  const [adminProfile, setAdminProfile] = useState(null);
  const [pageData, setPageData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [page, setPage] = useState(1);
  const [searchText, setSearchText] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');
  const [selectedUser, setSelectedUser] = useState(null);
  const [admins, setAdmins] = useState([]);
  const [permissionOptions, setPermissionOptions] = useState([]);
  const [selectedAdminId, setSelectedAdminId] = useState('');
  const [selectedPermissions, setSelectedPermissions] = useState([]);
  const [savingPermissions, setSavingPermissions] = useState(false);

  const availablePages = useMemo(() => NAV_ITEMS.filter((item) => {
    if (item.superAdmin) return isSuperAdmin;
    if (!item.permission || isSuperAdmin) return true;
    return adminProfile?.permissions?.includes(item.permission) ?? false;
  }), [adminProfile, isSuperAdmin]);

  const loadPage = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      if (activePage === 'overview' || activePage === 'usage' || activePage === 'reports') {
        const result = await apiRequest('/api/admin/dashboard');
        setPageData(result.dashboard);
      } else if (activePage === 'users' || activePage === 'active' || activePage === 'suspended' || activePage === 'deleted') {
        const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
        const status = activePage === 'active' ? 'active'
          : activePage === 'suspended' ? 'suspended'
            : activePage === 'deleted' ? 'deleted' : statusFilter;
        if (status !== 'all') params.set('status', status);
        if (searchQuery) params.set('q', searchQuery);
        const result = await apiRequest(`/api/admin/users?${params}`);
        setPageData(result);
      } else if (activePage === 'login-history' || activePage === 'registration-history') {
        const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
        if (activePage === 'registration-history') params.set('type', 'registration');
        const result = await apiRequest(`/api/admin/auth-events?${params}`);
        setPageData(result);
      } else if (activePage === 'activity') {
        const result = await apiRequest(`/api/admin/activity?page=${page}&pageSize=${PAGE_SIZE}`);
        setPageData(result);
      } else if (activePage === 'sessions') {
        const result = await apiRequest(`/api/admin/sessions?page=${page}&pageSize=${PAGE_SIZE}`);
        setPageData(result);
      } else if (activePage === 'contacts') {
        const result = await apiRequest(`/api/admin/contacts?page=${page}&pageSize=${PAGE_SIZE}`);
        setPageData(result);
      } else if (activePage === 'call-devices') {
        const result = await apiRequest('/api/admin/call-devices');
        setPageData(result);
      } else if (activePage === 'calls') {
        const result = await apiRequest(`/api/admin/calls?page=${page}&pageSize=${PAGE_SIZE}`);
        setPageData(result);
      } else if (activePage === 'audit') {
        const result = await apiRequest(`/api/admin/audit-logs?page=${page}&pageSize=${PAGE_SIZE}`);
        setPageData(result);
      } else if (activePage === 'admins') {
        const result = await apiRequest('/api/admin/admins');
        setAdmins(result.admins);
        setPageData(result);
      } else if (activePage === 'permissions') {
        const [permissionResult, adminResult] = await Promise.all([
          apiRequest('/api/admin/permissions'),
          apiRequest('/api/admin/admins')
        ]);
        setPermissionOptions(permissionResult.permissions);
        setAdmins(adminResult.admins);
        setPageData(permissionResult);
      } else if (activePage === 'security') {
        const result = await apiRequest('/api/admin/security');
        setPageData(result.security);
      } else if (activePage === 'system') {
        const result = await apiRequest('/api/admin/system');
        setPageData(result.system);
      } else if (activePage === 'profile') {
        const result = await apiRequest('/api/admin/profile');
        setPageData(result.profile);
      }
    } catch (requestError) {
      setPageData(null);
      setError(requestError.message);
    } finally {
      setLoading(false);
    }
  }, [activePage, apiRequest, page, searchQuery, statusFilter]);

  useEffect(() => {
    apiRequest('/api/admin/profile')
      .then((result) => setAdminProfile(result.profile))
      .catch((requestError) => setError(requestError.message));
  }, [apiRequest]);

  useEffect(() => {
    loadPage();
  }, [loadPage]);

  useEffect(() => {
    const selected = admins.find((entry) => entry.id === selectedAdminId);
    setSelectedPermissions(selected?.permissions || []);
  }, [admins, selectedAdminId]);

  useEffect(() => {
    if (adminProfile && !availablePages.some(({ id }) => id === activePage)) {
      setActivePage(availablePages[0]?.id || 'profile');
    }
  }, [activePage, adminProfile, availablePages]);

  const navigate = (pageId) => {
    setActivePage(pageId);
    setPage(1);
    setPageData(null);
    setError('');
    setSelectedUser(null);
  };

  const refresh = () => loadPage();

  const requestUserDetails = async (id) => {
    setError('');
    try {
      const result = await apiRequest(`/api/admin/users/${id}`);
      setSelectedUser(result.user);
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const changeAccountStatus = async (target, accountStatus) => {
    try {
      await apiRequest(`/api/admin/users/${target.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ accountStatus })
      });
      setSelectedUser(null);
      await refresh();
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const updateUserProfile = async (target, profile) => {
    try {
      const result = await apiRequest(`/api/admin/users/${target.id}`, {
        method: 'PATCH',
        body: JSON.stringify(profile)
      });
      setSelectedUser(result.user);
      await refresh();
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const sendPasswordReset = async (target) => {
    try {
      return await apiRequest(`/api/admin/users/${target.id}/password-reset`, { method: 'POST' });
    } catch (requestError) {
      setError(requestError.message);
      throw requestError;
    }
  };

  const softDelete = async (target) => {
    if (!window.confirm(`Move ${target.email} to Deleted Accounts?`)) return;
    try {
      await apiRequest(`/api/admin/users/${target.id}`, { method: 'DELETE' });
      setSelectedUser(null);
      await refresh();
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const restoreUser = async (target) => {
    try {
      await apiRequest(`/api/admin/users/${target.id}/restore`, { method: 'POST' });
      setSelectedUser(null);
      await refresh();
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const changeUserRole = async (target, role) => {
    try {
      await apiRequest(`/api/admin/users/${target.id}/role`, {
        method: 'PATCH',
        body: JSON.stringify({ role })
      });
      setSelectedUser(null);
      await refresh();
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const permanentlyDelete = async (target) => {
    const confirmation = window.prompt(`Permanently delete ${target.email}? Enter the account email to confirm.`);
    if (confirmation === null) return;
    try {
      await apiRequest(`/api/admin/users/${target.id}/permanent`, {
        method: 'DELETE',
        body: JSON.stringify({ confirmEmail: confirmation })
      });
      setSelectedUser(null);
      await refresh();
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const revokeSession = async (session) => {
    if (!window.confirm(`Revoke this session for ${session.email}?`)) return;
    try {
      await apiRequest(`/api/admin/sessions/${session.id}/revoke`, { method: 'POST' });
      await refresh();
    } catch (requestError) {
      setError(requestError.message);
    }
  };

  const savePermissions = async () => {
    setSavingPermissions(true);
    setError('');
    try {
      await apiRequest(`/api/admin/admins/${selectedAdminId}/permissions`, {
        method: 'PUT',
        body: JSON.stringify({ permissions: selectedPermissions })
      });
      const result = await apiRequest('/api/admin/admins');
      setAdmins(result.admins);
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSavingPermissions(false);
    }
  };

  const pageTotal = pageData?.total || 0;
  const pageCount = Math.max(1, Math.ceil(pageTotal / PAGE_SIZE));

  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <a className="admin-brand" href="/" aria-label="SignSpeak home">
          <span className="admin-brand-mark">S</span>
          <span>SignSpeak <small>ADMIN CONSOLE</small></span>
        </a>
        <p className="admin-nav-heading">MANAGEMENT</p>
        <nav className="admin-nav" aria-label="Admin navigation">
          {availablePages.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              className={`admin-nav-item${activePage === id ? ' is-active' : ''}`}
              onClick={() => navigate(id)}
              aria-current={activePage === id ? 'page' : undefined}
            >
              <Icon size={17} aria-hidden="true" />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="admin-sidebar-footer">
          <p>{user.displayName}</p>
          <span>{isSuperAdmin ? 'Super Admin' : 'Administrator'}</span>
          <button type="button" onClick={onLogout} aria-label="Sign out of admin panel">
            <LogOut size={16} aria-hidden="true" /> Sign out
          </button>
        </div>
      </aside>

      <main className="admin-main">
        <header className="admin-topbar">
          <div>
            <p className="admin-eyebrow">SIGNSPEAK CONTROL CENTER</p>
            <h1>{PAGE_TITLES[activePage] || 'Admin Panel'}</h1>
          </div>
          <div className="admin-topbar-user">
            <span className="admin-online-dot" />
            <span>{user.email}</span>
            <Bell size={17} aria-label="Notifications" />
          </div>
        </header>

        {error && <p className="admin-alert" role="alert">{error}</p>}

        <section className="admin-content" aria-live="polite">
          {loading && <div className="admin-empty">Loading management data…</div>}
          {!loading && !error && (activePage === 'overview' || activePage === 'usage' || activePage === 'reports') && (
            <DashboardView dashboard={pageData} />
          )}
          {!loading && !error && ['users', 'active', 'suspended', 'deleted'].includes(activePage) && (
            <UsersView
              data={pageData}
              activePage={activePage}
              searchText={searchText}
              setSearchText={setSearchText}
              statusFilter={statusFilter}
              setStatusFilter={setStatusFilter}
              onSearch={() => { setSearchQuery(searchText.trim()); setPage(1); }}
              onView={requestUserDetails}
              onChangeStatus={changeAccountStatus}
              onDelete={softDelete}
              onRestore={restoreUser}
              onChangeRole={changeUserRole}
              isSuperAdmin={isSuperAdmin}
              actorId={user.id}
            />
          )}
          {!loading && !error && (activePage === 'login-history' || activePage === 'registration-history') && (
            <AuthEventsView data={pageData} registrationOnly={activePage === 'registration-history'} />
          )}
          {!loading && !error && activePage === 'activity' && <ActivityView data={pageData} />}
          {!loading && !error && activePage === 'sessions' && <SessionsView data={pageData} onRevoke={revokeSession} />}
          {!loading && !error && activePage === 'contacts' && <ContactsView data={pageData} />}
          {!loading && !error && activePage === 'call-devices' && (
            <CallDevicesView data={pageData} apiRequest={apiRequest} onRefresh={loadPage} />
          )}
          {!loading && !error && activePage === 'calls' && <CallsView data={pageData} />}
          {!loading && !error && activePage === 'audit' && <AuditView data={pageData} />}
          {!loading && !error && activePage === 'admins' && (
            <AdminsView admins={admins} onChangeRole={changeUserRole} onSelect={setSelectedAdminId} />
          )}
          {!loading && !error && activePage === 'permissions' && (
            <PermissionsView
              permissions={permissionOptions}
              admins={admins}
              selectedAdminId={selectedAdminId}
              selectedPermissions={selectedPermissions}
              setSelectedAdminId={setSelectedAdminId}
              setSelectedPermissions={setSelectedPermissions}
              onSave={savePermissions}
              saving={savingPermissions}
            />
          )}
          {!loading && !error && activePage === 'security' && <SecurityView security={pageData} />}
          {!loading && !error && activePage === 'system' && <SystemView system={pageData} />}
          {!loading && !error && activePage === 'profile' && (
            <ProfileView
              profile={pageData || adminProfile}
              apiRequest={apiRequest}
              onUpdated={(profile) => {
                setAdminProfile(profile);
                setPageData(profile);
                onProfileUpdated?.({
                  ...user,
                  email: profile.email,
                  username: profile.username,
                  displayName: profile.displayName,
                  profileImageUrl: profile.profileImage,
                  emailVerifiedAt: profile.emailVerifiedAt
                });
              }}
            />
          )}
          {!loading && !error && activePage === 'admins' && selectedAdminId && (
            <div className="admin-notice">
              Selected Admin: {admins.find((entry) => entry.id === selectedAdminId)?.email}
            </div>
          )}
          {!loading && !error && selectedUser && (
            <UserDetails
              user={selectedUser}
              isSuperAdmin={isSuperAdmin}
              onClose={() => setSelectedUser(null)}
              onChangeStatus={changeAccountStatus}
              onRestore={restoreUser}
              onDelete={softDelete}
              onPermanentDelete={permanentlyDelete}
              onChangeRole={changeUserRole}
              onUpdate={updateUserProfile}
              onSendPasswordReset={sendPasswordReset}
              actorId={user.id}
            />
          )}
        </section>

        {pageData?.total > PAGE_SIZE && (
          <footer className="admin-pagination">
            <span>Page {page} of {pageCount} · {pageTotal.toLocaleString()} records</span>
            <div>
              <button type="button" disabled={page <= 1} onClick={() => setPage((value) => value - 1)} aria-label="Previous page">
                <ChevronLeft size={17} />
              </button>
              <button type="button" disabled={page >= pageCount} onClick={() => setPage((value) => value + 1)} aria-label="Next page">
                <ChevronRight size={17} />
              </button>
            </div>
          </footer>
        )}
      </main>
    </div>
  );
}

function DashboardView({ dashboard }) {
  if (!dashboard) return <EmptyState>No dashboard data is available.</EmptyState>;
  const cards = [
    ['Registered users', dashboard.users.totalUsers, Users],
    ['Verified accounts', dashboard.users.verifiedUsers, ShieldCheck],
    ['Active accounts', dashboard.users.activeUsers, CircleUserRound],
    ['Suspended accounts', dashboard.users.suspendedUsers, ShieldAlert],
    ['Users online', dashboard.users.onlineUsers, Activity],
    ['Total logins', dashboard.users.totalLogins, Fingerprint],
    ['Failed sign-ins', dashboard.authentication.failedLogins, ShieldAlert],
    ['New today', dashboard.authentication.registrationsToday, CalendarDays],
    ['Contact requests', dashboard.usage.contactRequests, Network],
    ['Calls initiated', dashboard.usage.callsInitiated, Video]
  ];
  const registrationPeak = Math.max(1, ...dashboard.registrations.map(({ total }) => total));
  const featurePeak = Math.max(1, ...dashboard.featureUsage.map(({ total }) => total));

  return (
    <>
      <div className="admin-welcome">
        <div>
          <p className="admin-eyebrow">LIVE PLATFORM OVERVIEW</p>
          <h2>Good to see you. Here’s what’s happening.</h2>
          <p>These figures are calculated from the SignSpeak SQLite database.</p>
        </div>
        <div className="admin-welcome-icon"><Activity size={25} /></div>
      </div>
      <div className="admin-stat-grid">
        {cards.map(([label, value, Icon]) => (
          <article className="admin-stat-card" key={label}>
            <div className="admin-stat-icon"><Icon size={18} aria-hidden="true" /></div>
            <p>{label}</p>
            <strong>{Number(value || 0).toLocaleString()}</strong>
          </article>
        ))}
      </div>
      <div className="admin-chart-grid">
        <section className="admin-panel-card">
          <div className="admin-section-heading">
            <div><h3>Registration growth</h3><p>Signups in the last 30 days</p></div>
            <CalendarDays size={18} />
          </div>
          {dashboard.registrations.length ? (
            <div className="admin-bar-chart" role="img" aria-label="Registration growth over the last 30 days">
              {dashboard.registrations.map(({ day, total }) => (
                <div className="admin-bar-column" key={day} title={`${day}: ${total}`}>
                  <span style={{ height: `${Math.max(4, (total / registrationPeak) * 100)}%` }} />
                  <small>{day.slice(5)}</small>
                </div>
              ))}
            </div>
          ) : <EmptyState>No registrations have been recorded yet.</EmptyState>}
        </section>
        <section className="admin-panel-card">
          <div className="admin-section-heading">
            <div><h3>Feature activity</h3><p>Tracked SignSpeak actions</p></div>
            <BarChart3 size={18} />
          </div>
          {dashboard.featureUsage.length ? (
            <div className="admin-feature-bars">
              {dashboard.featureUsage.map(({ action, total }) => (
                <div className="admin-feature-row" key={action}>
                  <span>{action.replaceAll('_', ' ')}</span>
                  <div><span style={{ width: `${Math.max(2, (total / featurePeak) * 100)}%` }} /></div>
                  <strong>{total.toLocaleString()}</strong>
                </div>
              ))}
            </div>
          ) : <EmptyState>Usage analytics will appear as users work in SignSpeak.</EmptyState>}
        </section>
      </div>
      <p className="admin-data-note"><Clock3 size={14} /> Failed login and usage tracking starts when this update is deployed.</p>
    </>
  );
}

function UsersView({
  data,
  activePage,
  searchText,
  setSearchText,
  statusFilter,
  setStatusFilter,
  onSearch,
  onView,
  onChangeStatus,
  onDelete,
  onRestore,
  onChangeRole,
  isSuperAdmin,
  actorId
}) {
  const users = data?.users || [];
  return (
    <>
      <section className="admin-panel-card">
        <form className="admin-toolbar" onSubmit={(event) => { event.preventDefault(); onSearch(); }}>
          <label className="admin-search">
            <Search size={17} aria-hidden="true" />
            <input value={searchText} onChange={(event) => setSearchText(event.target.value)} placeholder="Search name, email or user ID" />
          </label>
          {activePage === 'users' && (
            <select aria-label="Filter by account status" value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}>
              <option value="all">All account statuses</option>
              <option value="active">Active</option>
              <option value="suspended">Suspended</option>
              <option value="deleted">Deleted</option>
            </select>
          )}
          <button className="admin-button admin-button-primary" type="submit">Search accounts</button>
        </form>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr><th>User</th><th>Registered</th><th>Verified</th><th>Role</th><th>Status</th><th>Last login</th><th>Logins</th><th>Actions</th></tr>
            </thead>
            <tbody>
              {users.map((entry) => {
                const canManage = entry.id !== actorId
                  && entry.role !== 'super_admin'
                  && (isSuperAdmin || entry.role === 'user');
                return (
                <tr key={entry.id}>
                  <td>
                    <button className="admin-user-link" type="button" onClick={() => onView(entry.id)}>
                      {entry.profileImage
                        ? <img className="admin-avatar" src={entry.profileImage} alt="" loading="lazy" referrerPolicy="no-referrer" />
                        : <span className="admin-avatar">{entry.displayName?.slice(0, 1).toUpperCase() || '?'}</span>}
                      <span><strong>{entry.displayName}</strong><small>{entry.email}</small></span>
                    </button>
                  </td>
                  <td>{formatDate(entry.createdAt)}</td>
                  <td><StatusBadge value={entry.emailVerifiedAt ? 'Verified' : 'Unverified'} /></td>
                  <td>{entry.role.replace('_', ' ')}</td>
                  <td><StatusBadge value={entry.accountStatus} /></td>
                  <td>{formatDate(entry.lastLoginAt)}</td>
                  <td>{entry.successfulLoginCount}</td>
                  <td>
                    <div className="admin-row-actions">
                      <button type="button" onClick={() => onView(entry.id)}>View</button>
                      {canManage && entry.accountStatus !== 'deleted' && (
                        <button type="button" onClick={() => onChangeStatus(entry, entry.accountStatus === 'active' ? 'suspended' : 'active')}>
                          {entry.accountStatus === 'active' ? 'Suspend' : 'Unblock'}
                        </button>
                      )}
                      {canManage && entry.accountStatus === 'deleted' && <button type="button" onClick={() => onRestore(entry)}>Restore</button>}
                      {canManage && entry.accountStatus !== 'deleted' && <button type="button" onClick={() => onDelete(entry)}>Delete</button>}
                      {isSuperAdmin && canManage && entry.role === 'user' && entry.emailVerifiedAt && entry.accountStatus === 'active' && (
                        <button type="button" onClick={() => onChangeRole(entry, 'admin')}>Make admin</button>
                      )}
                      {isSuperAdmin && canManage && entry.role === 'admin' && (
                        <button type="button" onClick={() => onChangeRole(entry, 'user')}>Remove admin</button>
                      )}
                    </div>
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
          {!users.length && <EmptyState>No accounts match these filters.</EmptyState>}
        </div>
      </section>
      <p className="admin-data-note"><Users size={14} /> User search and filters run on the server. Password hashes are never returned.</p>
    </>
  );
}

function AuthEventsView({ data, registrationOnly }) {
  const events = data?.events || [];
  return (
    <DataTable
      title={registrationOnly ? 'Registration events' : 'Authentication events'}
      description="Authentication metadata only; credentials and tokens are never recorded."
      columns={['Account', 'Event', 'Time', 'IP address', 'Browser']}
      rows={events.map((event) => [
        <span key="account"><strong>{event.account || 'Unknown account'}</strong><small>{event.email || 'No email recorded'}</small></span>,
        <StatusBadge key="event" value={event.eventType.replaceAll('_', ' ')} />,
        formatDate(event.createdAt),
        event.ipAddress || '—',
        shortUserAgent(event.userAgent)
      ])}
      emptyText="No authentication events have been recorded."
    />
  );
}

function ActivityView({ data }) {
  const rows = data?.activity || [];
  return (
    <DataTable
      title="SignSpeak user activity"
      description="Feature events contain action metadata only. Webcam video, audio and call content are not collected."
      columns={['User', 'Action', 'Time', 'IP address', 'Browser']}
      rows={rows.map((event) => [
        <span key="user"><strong>{event.displayName || 'Deleted account'}</strong><small>{event.email || 'Account removed'}</small></span>,
        event.summary,
        formatDate(event.createdAt),
        event.ipAddress || '—',
        shortUserAgent(event.userAgent)
      ])}
      emptyText="No activity has been recorded yet."
    />
  );
}

function SessionsView({ data, onRevoke }) {
  const sessions = data?.sessions || [];
  return (
    <DataTable
      title="Active sessions"
      description="Only session metadata is shown. Session credentials are never exposed."
      columns={['Account', 'Created', 'Last active', 'Expires', 'IP address', 'Browser', 'Action']}
      rows={sessions.map((session) => [
        <span key="user"><strong>{session.displayName}</strong><small>{session.email}</small></span>,
        formatDate(session.createdAt),
        formatDate(session.lastSeenAt),
        formatDate(session.expiresAt),
        session.ipAddress || '—',
        shortUserAgent(session.userAgent),
        <button className="admin-button admin-button-danger" type="button" onClick={() => onRevoke(session)} key="revoke">Revoke</button>
      ])}
      emptyText="There are no active sessions."
    />
  );
}

function ContactsView({ data }) {
  return (
    <DataTable
      title="Contact requests"
      description="Contact relationship metadata only."
      columns={['Requester', 'Recipient', 'Status', 'Created']}
      rows={(data?.contacts || []).map((contact) => [
        <span key="requester"><strong>{contact.requesterName}</strong><small>{contact.requesterEmail}</small></span>,
        <span key="recipient"><strong>{contact.addresseeName}</strong><small>{contact.addresseeEmail}</small></span>,
        <StatusBadge key="status" value={contact.status} />,
        formatDate(contact.createdAt)
      ])}
      emptyText="No contact requests are recorded."
    />
  );
}

function CallDevicesView({ data, apiRequest, onRefresh }) {
  const [editingId, setEditingId] = useState('');
  const [form, setForm] = useState({
    userId: '',
    phoneNumber: '',
    deviceName: '',
    deviceType: 'mobile',
    phoneVerified: false,
    callsEnabled: false
  });
  const [saveError, setSaveError] = useState('');
  const [saving, setSaving] = useState(false);

  const resetForm = () => {
    setEditingId('');
    setSaveError('');
    setForm({
      userId: '',
      phoneNumber: '',
      deviceName: '',
      deviceType: 'mobile',
      phoneVerified: false,
      callsEnabled: false
    });
  };

  const submitDevice = async (event) => {
    event.preventDefault();
    setSaveError('');
    setSaving(true);
    try {
      await apiRequest(
        editingId ? `/api/admin/call-devices/${editingId}` : '/api/admin/call-devices',
        {
          method: editingId ? 'PATCH' : 'POST',
          body: JSON.stringify(form)
        }
      );
      resetForm();
      await onRefresh();
    } catch (error) {
      setSaveError(error.message);
    } finally {
      setSaving(false);
    }
  };

  const editDevice = (device) => {
    setEditingId(device.id);
    setSaveError('');
    setForm({
      userId: device.userId,
      phoneNumber: device.phoneNumber,
      deviceName: device.deviceName,
      deviceType: device.deviceType,
      phoneVerified: Boolean(device.phoneVerifiedAt),
      callsEnabled: device.callsEnabled
    });
  };

  const removeDevice = async (device) => {
    if (!window.confirm(`Remove ${device.deviceName} for ${device.email}?`)) return;
    setSaveError('');
    try {
      await apiRequest(`/api/admin/call-devices/${device.id}`, { method: 'DELETE' });
      if (editingId === device.id) resetForm();
      await onRefresh();
    } catch (error) {
      setSaveError(error.message);
    }
  };

  return (
    <div className="call-device-management">
      <section className="call-device-card">
        <h2>{editingId ? 'Update approved device' : 'Register an approved device'}</h2>
        <p>
          Only Super Admins can add phone numbers or enable calling. Phone verification is a manual admin attestation;
          SMS/OTP delivery is not configured in this deployment.
        </p>
        <form className="call-device-form" onSubmit={submitDevice}>
          <label>
            Existing verified account
            <select
              required
              value={form.userId}
              onChange={(event) => setForm((current) => ({ ...current, userId: event.target.value }))}
            >
              <option value="">Select an account</option>
              {(data?.users || []).map((account) => (
                <option key={account.id} value={account.id}>
                  {account.displayName} · {account.email}
                </option>
              ))}
            </select>
          </label>
          <label>
            Phone number (E.164)
            <input
              required
              type="tel"
              autoComplete="tel"
              placeholder="+14155550123"
              value={form.phoneNumber}
              onChange={(event) => setForm((current) => ({
                ...current,
                phoneNumber: event.target.value,
                phoneVerified: false,
                callsEnabled: false
              }))}
            />
          </label>
          <label>
            Device name
            <input
              required
              minLength={2}
              maxLength={80}
              placeholder="Person B's mobile"
              value={form.deviceName}
              onChange={(event) => setForm((current) => ({ ...current, deviceName: event.target.value }))}
            />
          </label>
          <label>
            Device type
            <select
              value={form.deviceType}
              onChange={(event) => setForm((current) => ({ ...current, deviceType: event.target.value }))}
            >
              <option value="mobile">Mobile phone</option>
              <option value="desktop">Laptop / desktop</option>
            </select>
          </label>
          <label className="call-device-check">
            <input
              type="checkbox"
              checked={form.phoneVerified}
              onChange={(event) => setForm((current) => ({
                ...current,
                phoneVerified: event.target.checked,
                callsEnabled: event.target.checked && current.callsEnabled
              }))}
            />
            I have independently verified this phone number
          </label>
          <label className="call-device-check">
            <input
              type="checkbox"
              checked={form.callsEnabled}
              onChange={(event) => setForm((current) => ({ ...current, callsEnabled: event.target.checked }))}
            />
            Enable SignSpeak calls for this account
          </label>
          {saveError && <p className="call-device-error" role="alert">{saveError}</p>}
          <div className="call-device-actions">
            <button type="submit" className="admin-button admin-button-primary" disabled={saving}>
              {saving ? 'Saving…' : editingId ? 'Save device' : 'Add device'}
            </button>
            {editingId && (
              <button type="button" className="admin-button" onClick={resetForm}>
                Cancel edit
              </button>
            )}
          </div>
        </form>
      </section>

      <section className="call-device-card">
        <header className="call-device-table-heading">
          <h2>Authorized calling devices</h2>
          <button
            type="button"
            className="admin-button"
            onClick={() => onRefresh().catch((error) => setSaveError(error.message))}
          >
            Refresh status
          </button>
        </header>
        <div className="admin-table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>Account</th>
                <th>Phone / device</th>
                <th>Phone verified</th>
                <th>Calling</th>
                <th>Account status</th>
                <th>Registered device online</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {(data?.devices || []).map((device) => {
                const deviceConnected = device.deviceType === 'mobile'
                  ? device.mobileConnected
                  : device.desktopConnected;
                return (
                  <tr key={device.id}>
                    <td><strong>{device.displayName}</strong><small>{device.email}</small></td>
                    <td><strong>{device.phoneNumber}</strong><small>{device.deviceName} · {device.deviceType}</small></td>
                    <td><StatusBadge value={device.phoneVerifiedAt ? 'verified' : 'pending'} /></td>
                    <td><StatusBadge value={device.callsEnabled ? 'enabled' : 'disabled'} /></td>
                    <td>{device.online ? 'Online' : 'Offline'} · {device.connectedSessions} session(s)</td>
                    <td>{deviceConnected ? 'Connected' : 'Not connected'}</td>
                    <td>
                      <div className="admin-row-actions">
                        <button type="button" className="admin-button" onClick={() => editDevice(device)}>Edit</button>
                        <button type="button" className="admin-button admin-button-danger" onClick={() => removeDevice(device)}>Remove</button>
                      </div>
                    </td>
                  </tr>
                );
              })}
              {(!data?.devices || data.devices.length === 0) && (
                <tr><td colSpan={7}>No calling devices have been approved.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}

function CallsView({ data }) {
  return (
    <DataTable
      title="Call activity"
      description="Call timestamps, participants and state only. Audio, video and conversation content are not captured."
      columns={['Caller', 'Recipient', 'Mode', 'Status', 'Started', 'Answered', 'Ended']}
      rows={(data?.calls || []).map((call) => [
        <span key="caller"><strong>{call.callerName}</strong><small>{call.callerEmail}</small></span>,
        <span key="callee"><strong>{call.calleeName}</strong><small>{call.calleeEmail}</small></span>,
        call.mode,
        <StatusBadge key="status" value={call.status} />,
        formatDate(call.createdAt),
        formatDate(call.answeredAt),
        formatDate(call.endedAt)
      ])}
      emptyText="No calls are recorded."
    />
  );
}

function AuditView({ data }) {
  return (
    <DataTable
      title="Administrator audit trail"
      description="Append-only history of privileged actions."
      columns={['Administrator', 'Action', 'Affected account', 'Result', 'Time']}
      rows={(data?.logs || []).map((log) => [
        log.adminEmail || 'System initialization',
        <span key="action"><strong>{log.action.replaceAll('_', ' ')}</strong><small>{log.updatedValues}</small></span>,
        log.targetEmail || log.targetUserId || '—',
        <StatusBadge key="result" value={log.result} />,
        formatDate(log.createdAt)
      ])}
      emptyText="No audit events have been recorded."
    />
  );
}

function AdminsView({ admins, onChangeRole, onSelect }) {
  return (
    <section className="admin-panel-card">
      <div className="admin-section-heading">
        <div><h2>Administrator accounts</h2><p>Promote verified users from the All Users page.</p></div>
        <ShieldCheck size={19} />
      </div>
      <div className="admin-admin-list">
        {admins.map((admin) => (
          <article className="admin-admin-row" key={admin.id}>
            <div><strong>{admin.displayName}</strong><small>{admin.email}</small><StatusBadge value={admin.role.replace('_', ' ')} /></div>
            <div className="admin-admin-permissions">{admin.permissions.length ? admin.permissions.join(' · ') : 'No permissions assigned'}</div>
            <div className="admin-row-actions">
              {admin.role === 'admin' && <button type="button" onClick={() => onSelect(admin.id)}>Manage permissions</button>}
              {admin.role === 'admin' && <button type="button" onClick={() => onChangeRole(admin, 'user')}>Remove admin role</button>}
            </div>
          </article>
        ))}
        {!admins.length && <EmptyState>No admin accounts are configured.</EmptyState>}
      </div>
    </section>
  );
}

function PermissionsView({
  permissions,
  admins,
  selectedAdminId,
  selectedPermissions,
  setSelectedAdminId,
  setSelectedPermissions,
  onSave,
  saving
}) {
  const adminAccounts = admins.filter(({ role }) => role === 'admin');
  return (
    <section className="admin-panel-card">
      <div className="admin-section-heading">
        <div><h2>Permission assignments</h2><p>Super Admin access is provisioned only through the controlled server environment.</p></div>
        <Fingerprint size={19} />
      </div>
      <label className="admin-select-label">
        Administrator account
        <select value={selectedAdminId} onChange={(event) => setSelectedAdminId(event.target.value)}>
          <option value="">Select an administrator</option>
          {adminAccounts.map((admin) => <option value={admin.id} key={admin.id}>{admin.displayName} · {admin.email}</option>)}
        </select>
      </label>
      {selectedAdminId && (
        <div className="admin-permission-grid">
          {permissions.map((permission) => (
            <label key={permission.key} className="admin-permission-option">
              <input
                type="checkbox"
                checked={selectedPermissions.includes(permission.key)}
                onChange={(event) => setSelectedPermissions((current) => (
                  event.target.checked
                    ? [...current, permission.key]
                    : current.filter((value) => value !== permission.key)
                ))}
              />
              <span><strong>{permission.label}</strong><small>{permission.key}</small></span>
            </label>
          ))}
          <button className="admin-button admin-button-primary" type="button" disabled={saving} onClick={onSave}>
            {saving ? 'Saving…' : 'Save permissions'}
          </button>
        </div>
      )}
    </section>
  );
}

function SecurityView({ security }) {
  if (!security) return <EmptyState>Security data is unavailable.</EmptyState>;
  const values = [
    ['Failed logins (24h)', security.failedLoginsLast24Hours],
    ['Active sessions', security.activeSessions],
    ['Revoked sessions retained', security.revokedSessions],
    ['Suspended accounts', security.suspendedAccounts],
    ['Deleted accounts', security.deletedAccounts],
    ['Telemetry retention', `${security.eventRetentionDays} days`]
  ];
  return (
    <div className="admin-stat-grid">
      {values.map(([label, value]) => <article className="admin-stat-card" key={label}><p>{label}</p><strong>{value}</strong></article>)}
      <p className="admin-data-note">Admin mutations are permission-checked on the server. Authentication and feature telemetry is retained for 90 days.</p>
    </div>
  );
}

function SystemView({ system }) {
  if (!system) return <EmptyState>System information is unavailable.</EmptyState>;
  return (
    <section className="admin-panel-card admin-system-list">
      <h2>Runtime information</h2>
      <p><span>Backend runtime</span><strong>{system.runtime}</strong></p>
      <p><span>Database</span><strong>{system.database}</strong></p>
      <p><span>Telemetry retention</span><strong>{system.eventRetentionDays} days</strong></p>
      <p><span>Snapshot time</span><strong>{formatDate(system.capturedAt)}</strong></p>
      <small>Secrets and environment variable values are intentionally never exposed here.</small>
    </section>
  );
}

function ProfileView({ profile, apiRequest, onUpdated }) {
  const [displayName, setDisplayName] = useState(profile?.displayName || '');
  const [username, setUsername] = useState(profile?.username || '');
  const [email, setEmail] = useState(profile?.email || '');
  const [profileImageUrl, setProfileImageUrl] = useState(profile?.profileImage || '');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [verificationUrl, setVerificationUrl] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setDisplayName(profile?.displayName || '');
    setUsername(profile?.username || '');
    setEmail(profile?.email || '');
    setProfileImageUrl(profile?.profileImage || '');
  }, [profile]);

  const saveProfile = async (event) => {
    event.preventDefault();
    setError('');
    setNotice('');
    setVerificationUrl('');
    if (newPassword && newPassword !== confirmPassword) {
      setError('The new passwords do not match.');
      return;
    }

    setSaving(true);
    try {
      const result = await apiRequest('/api/admin/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          displayName,
          username,
          email,
          profileImageUrl,
          currentPassword,
          ...(newPassword ? { newPassword } : {})
        })
      });
      onUpdated(result.profile);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
      setNotice(result.message);
      setVerificationUrl(result.developmentVerificationUrl || '');
    } catch (requestError) {
      setError(requestError.message);
    } finally {
      setSaving(false);
    }
  };

  if (!profile) return <EmptyState>Admin profile is unavailable.</EmptyState>;
  return (
    <section className="admin-panel-card admin-profile-card">
      <div className="admin-profile-heading">
        {profile.profileImage
          ? <img className="admin-profile-avatar" src={profile.profileImage} alt="" referrerPolicy="no-referrer" />
          : <span className="admin-profile-avatar">{profile.displayName?.slice(0, 1).toUpperCase() || 'A'}</span>}
        <div>
          <h2>{profile.displayName}</h2>
          <p>{profile.email}</p>
          <StatusBadge value={profile.role.replace('_', ' ')} />
        </div>
      </div>
      <form className="admin-profile-form" onSubmit={saveProfile}>
        <label>
          Display name
          <input value={displayName} minLength={2} maxLength={80} required onChange={(event) => setDisplayName(event.target.value)} />
        </label>
        <label>
          Username
          <input value={username} minLength={3} maxLength={32} autoComplete="username" required onChange={(event) => setUsername(event.target.value)} />
        </label>
        <label>
          Email
          <input type="email" value={email} maxLength={254} autoComplete="email" required onChange={(event) => setEmail(event.target.value)} />
        </label>
        <label>
          Profile image URL
          <input type="url" value={profileImageUrl} maxLength={2048} placeholder="https://example.com/photo.jpg" onChange={(event) => setProfileImageUrl(event.target.value)} />
        </label>
        <label>
          Current password <span>(required to change username, email or password)</span>
          <input type="password" value={currentPassword} maxLength={128} autoComplete="current-password" onChange={(event) => setCurrentPassword(event.target.value)} />
        </label>
        <label>
          New password <span>(leave blank to keep current password)</span>
          <input type="password" value={newPassword} minLength={6} maxLength={128} autoComplete="new-password" onChange={(event) => setNewPassword(event.target.value)} />
        </label>
        {newPassword && (
          <label>
            Confirm new password
            <input type="password" value={confirmPassword} minLength={6} maxLength={128} autoComplete="new-password" onChange={(event) => setConfirmPassword(event.target.value)} />
          </label>
        )}
        {error && <p className="admin-profile-error" role="alert">{error}</p>}
        {notice && <p className="admin-profile-notice" role="status">{notice}</p>}
        {verificationUrl && <a className="admin-profile-verification" href={verificationUrl}>Open email verification link</a>}
        <button className="admin-button admin-button-primary" type="submit" disabled={saving}>
          {saving ? 'Saving…' : 'Save admin profile'}
        </button>
      </form>
      <p className="admin-profile-verification-state">
        Email status: {profile.emailVerifiedAt ? 'Verified' : 'Not verified'}
        {!profile.emailVerifiedAt && ' — email verification is needed for verified-account features, not sign-in.'}
      </p>
      <h3>Assigned permissions</h3>
      <ul>{profile.permissions.map((permission) => <li key={permission}>{permission}</li>)}</ul>
    </section>
  );
}

function UserDetails({
  user,
  isSuperAdmin,
  actorId,
  onClose,
  onChangeStatus,
  onRestore,
  onDelete,
  onPermanentDelete,
  onChangeRole,
  onUpdate,
  onSendPasswordReset
}) {
  const [displayName, setDisplayName] = useState(user.displayName);
  const [profileImageUrl, setProfileImageUrl] = useState(user.profileImage || '');
  const [passwordResetNotice, setPasswordResetNotice] = useState('');
  const [developmentResetUrl, setDevelopmentResetUrl] = useState('');
  useEffect(() => {
    setDisplayName(user.displayName);
    setProfileImageUrl(user.profileImage || '');
  }, [user.id, user.displayName, user.profileImage]);
  const canManage = user.id !== actorId
    && user.role !== 'super_admin'
    && (isSuperAdmin || user.role === 'user');

  return (
    <section className="admin-panel-card admin-user-detail">
      <div className="admin-section-heading">
        <div><h2>User profile</h2><p>Account information and permitted activity metadata.</p></div>
        <button className="admin-button" type="button" onClick={onClose}>Close</button>
      </div>
      <div className="admin-detail-grid">
        <form className="admin-detail-name" onSubmit={(event) => {
          event.preventDefault();
          onUpdate(user, { displayName, profileImageUrl });
        }}>
          <label htmlFor="admin-user-display-name">Full name</label>
          <div>
            <input id="admin-user-display-name" value={displayName} minLength={2} maxLength={80} disabled={!canManage} onChange={(event) => setDisplayName(event.target.value)} />
            <button className="admin-button admin-button-primary" type="submit" disabled={!canManage}>Save</button>
          </div>
          <label htmlFor="admin-user-profile-image">Profile image URL</label>
          <div>
            <input id="admin-user-profile-image" type="url" value={profileImageUrl} placeholder="https://example.com/photo.jpg" disabled={!canManage} onChange={(event) => setProfileImageUrl(event.target.value)} />
            <button className="admin-button admin-button-primary" type="submit" disabled={!canManage}>Save image</button>
          </div>
        </form>
        <p><span>Email</span><strong>{user.email}</strong></p>
        <p><span>User ID</span><strong>{user.id}</strong></p>
        <p><span>Role</span><strong>{user.role}</strong></p>
        <p><span>Account status</span><strong>{user.accountStatus}</strong></p>
        <p><span>Email verified</span><strong>{user.emailVerifiedAt ? 'Yes' : 'No'}</strong></p>
        <p><span>Registered</span><strong>{formatDate(user.createdAt)}</strong></p>
        <p><span>Last sign-in</span><strong>{formatDate(user.lastLoginAt)}</strong></p>
        <p><span>Last sign-out</span><strong>{formatDate(user.lastLogoutAt)}</strong></p>
        <p><span>Total successful logins</span><strong>{user.successfulLoginCount}</strong></p>
        <p><span>Current sessions</span><strong>{user.activeSessions.length}</strong></p>
      </div>
      <div className="admin-row-actions admin-detail-actions">
        {canManage && user.accountStatus !== 'deleted' && (
          <button className="admin-button" type="button" onClick={() => onChangeStatus(user, user.accountStatus === 'active' ? 'suspended' : 'active')}>
            {user.accountStatus === 'active' ? 'Suspend account' : 'Unblock account'}
          </button>
        )}
        {canManage && user.accountStatus === 'active' && user.emailVerifiedAt && (
          <button className="admin-button" type="button" onClick={async () => {
            setPasswordResetNotice('');
            setDevelopmentResetUrl('');
            try {
              const result = await onSendPasswordReset(user);
              setPasswordResetNotice(result.message);
              setDevelopmentResetUrl(result.developmentResetUrl || '');
            } catch {
              setPasswordResetNotice('Password reset email could not be sent.');
            }
          }}>Send password reset</button>
        )}
        {canManage && user.accountStatus === 'deleted' && <button className="admin-button" type="button" onClick={() => onRestore(user)}>Restore account</button>}
        {canManage && user.accountStatus !== 'deleted' && <button className="admin-button admin-button-danger" type="button" onClick={() => onDelete(user)}>Soft delete</button>}
        {isSuperAdmin && user.accountStatus === 'deleted' && user.role !== 'super_admin' && (
          <button className="admin-button admin-button-danger" type="button" onClick={() => onPermanentDelete(user)}>Permanently delete</button>
        )}
        {isSuperAdmin && canManage && user.role === 'user' && user.emailVerifiedAt && user.accountStatus === 'active' && (
          <button className="admin-button admin-button-primary" type="button" onClick={() => onChangeRole(user, 'admin')}>Promote to Admin</button>
        )}
        {isSuperAdmin && canManage && user.role === 'admin' && (
          <button className="admin-button" type="button" onClick={() => onChangeRole(user, 'user')}>Remove Admin role</button>
        )}
      </div>
      {passwordResetNotice && (
        <div className="admin-notice" role="status">
          <p>{passwordResetNotice}</p>
          {developmentResetUrl && <a href={developmentResetUrl}>Open development reset link</a>}
        </div>
      )}
      <div className="admin-detail-columns">
        <section><h3>Recent authentication</h3>{user.recentAuthEvents.map((event, index) => <p key={`${event.createdAt}-${index}`}>{event.eventType.replaceAll('_', ' ')} · {formatDate(event.createdAt)}</p>)}</section>
        <section><h3>Recent SignSpeak actions</h3>{user.recentActivity.map((event, index) => <p key={`${event.createdAt}-${index}`}>{event.summary} · {formatDate(event.createdAt)}</p>)}</section>
      </div>
    </section>
  );
}

function DataTable({ title, description, columns, rows, emptyText }) {
  return (
    <section className="admin-panel-card">
      <div className="admin-section-heading">
        <div><h2>{title}</h2><p>{description}</p></div>
        <Database size={18} />
      </div>
      <div className="admin-table-wrap">
        <table className="admin-table">
          <thead><tr>{columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
          <tbody>{rows.map((row, rowIndex) => (
            <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cell?.key || cellIndex}>{cell}</td>)}</tr>
          ))}</tbody>
        </table>
        {!rows.length && <EmptyState>{emptyText}</EmptyState>}
      </div>
    </section>
  );
}

function StatusBadge({ value }) {
  const normalized = String(value).toLowerCase().replaceAll(' ', '-');
  return <span className={`admin-badge status-${normalized}`}>{value}</span>;
}

function EmptyState({ children }) {
  return <div className="admin-empty">{children}</div>;
}

function formatDate(value) {
  if (!value) return '—';
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString();
}

function shortUserAgent(value) {
  return value ? value.slice(0, 72) : '—';
}
