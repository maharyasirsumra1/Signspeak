import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, LogOut, Phone, UserPlus, X } from 'lucide-react';
import SignSpeakFlowers from './SignSpeakFlowers.jsx';
import './SignSpeakLogin.css';

const AccountContext = createContext(null);
let googleScriptPromise;
let facebookScriptPromise;
let facebookSdkAppId = '';

function loadGoogleIdentityScript() {
  if (window.google?.accounts?.id) return Promise.resolve();
  if (!googleScriptPromise) {
    googleScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://accounts.google.com/gsi/client';
      script.async = true;
      script.defer = true;
      script.onload = () => {
        if (window.google?.accounts?.id) resolve();
        else {
          googleScriptPromise = null;
          reject(new Error('Google sign-in could not be loaded. Please try again.'));
        }
      };
      script.onerror = () => {
        googleScriptPromise = null;
        reject(new Error('Google sign-in could not be loaded. Check your internet connection.'));
      };
      document.head.appendChild(script);
    });
  }
  return googleScriptPromise;
}

function loadFacebookSdk(appId) {
  if (window.FB?.login) {
    if (facebookSdkAppId !== appId) {
      return initializeFacebookSdk(appId);
    }
    return Promise.resolve();
  }
  if (!facebookScriptPromise) {
    facebookScriptPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://connect.facebook.net/en_US/sdk.js';
      script.async = true;
      script.defer = true;
      script.onload = () => {
        if (window.FB?.login) {
          initializeFacebookSdk(appId).then(resolve).catch((error) => {
            facebookScriptPromise = null;
            reject(error);
          });
        } else {
          facebookScriptPromise = null;
          reject(new Error('Facebook sign-in could not be loaded. Please try again.'));
        }
      };
      script.onerror = () => {
        facebookScriptPromise = null;
        reject(new Error('Facebook sign-in could not be loaded. Check your internet connection.'));
      };
      document.head.appendChild(script);
    });
  }
  return facebookScriptPromise;
}

function initializeFacebookSdk(appId) {
  try {
    window.FB.init({ appId, cookie: true, xfbml: false, version: 'v27.0' });
    facebookSdkAppId = appId;
    return Promise.resolve();
  } catch {
    return Promise.reject(new Error('Facebook sign-in could not be initialized. Check your app settings.'));
  }
}

export function useAccount() {
  const context = useContext(AccountContext);
  if (!context) throw new Error('useAccount must be used inside AccountShell.');
  return context;
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers
    }
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`The server returned an invalid response (${response.status}).`);
  }
  if (!response.ok) throw new Error(payload.error || payload.message || `Request failed (${response.status}).`);
  return payload;
}

export default function AccountShell({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [authError, setAuthError] = useState('');
  const [providerNotice, setProviderNotice] = useState('');
  const [authMode, setAuthMode] = useState('login');
  const [verificationUrl, setVerificationUrl] = useState('');
  const [verificationEmail, setVerificationEmail] = useState('');
  const [googleClientId, setGoogleClientId] = useState(null);
  const [facebookAppId, setFacebookAppId] = useState(null);
  const [contacts, setContacts] = useState([]);
  const [calls, setCalls] = useState([]);
  const [showContacts, setShowContacts] = useState(false);
  const [showHistory, setShowHistory] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [currentCall, setCurrentCall] = useState(null);
  const [socketStatus, setSocketStatus] = useState('offline');
  const [localVideoStream, setLocalVideoStream] = useState(null);
  const socketRef = useRef(null);
  const reconnectTimerRef = useRef(null);
  const signalListenersRef = useRef(new Set());
  const verificationStartedRef = useRef(false);
  const googleButtonRef = useRef(null);

  const handleFacebookAccessToken = useCallback(async (accessToken) => {
    setAuthError('');
    setProviderNotice('');
    try {
      const result = await apiRequest('/api/auth/facebook', {
        method: 'POST',
        body: JSON.stringify({ accessToken })
      });
      setUser(result.user);
    } catch (error) {
      setAuthError(error.message);
    }
  }, []);

  const startFacebookSignIn = useCallback(() => {
    if (!facebookAppId) {
      setProviderNotice(
        facebookAppId === null
          ? 'Facebook sign-in is loading.'
          : 'Facebook sign-in needs setup. See SOCIAL_SIGN_IN.md.'
      );
      return;
    }
    if (!window.FB?.login) {
      setProviderNotice('Facebook sign-in is loading. Try again shortly.');
      return;
    }
    try {
      window.FB.login((result) => {
        const accessToken = result?.authResponse?.accessToken;
        if (!accessToken) {
          setProviderNotice('Facebook sign-in was cancelled.');
          return;
        }
        void handleFacebookAccessToken(accessToken);
      }, { scope: 'public_profile,email' });
    } catch {
      setProviderNotice('Facebook sign-in could not start. Check your app settings.');
    }
  }, [facebookAppId, handleFacebookAccessToken]);

  const handleGoogleCredential = useCallback(async ({ credential }) => {
    if (!credential) {
      setProviderNotice('Google sign-in did not complete. Please try again.');
      return;
    }
    setAuthError('');
    setProviderNotice('');
    try {
      const result = await apiRequest('/api/auth/google', {
        method: 'POST',
        body: JSON.stringify({ credential })
      });
      setUser(result.user);
    } catch (error) {
      setAuthError(error.message);
    }
  }, []);

  useEffect(() => {
    let active = true;
    apiRequest('/api/auth/social/config')
      .then(({ googleClientId: clientId, facebookAppId: appId }) => {
        if (active) {
          setGoogleClientId(clientId || '');
          setFacebookAppId(appId || '');
        }
      })
      .catch(() => {
        if (active) {
          setGoogleClientId('');
          setFacebookAppId('');
        }
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const container = googleButtonRef.current;
    if (authMode !== 'login' || !googleClientId || !container) return undefined;
    let active = true;
    loadGoogleIdentityScript()
      .then(() => {
        if (!active || !container.isConnected) return;
        window.google.accounts.id.initialize({
          client_id: googleClientId,
          callback: handleGoogleCredential
        });
        window.google.accounts.id.renderButton(container, {
          type: 'standard',
          theme: 'outline',
          size: 'medium',
          text: 'signin_with',
          shape: 'rectangular',
          width: 120
        });
      })
      .catch((error) => {
        if (active) setAuthError(error.message);
      });
    return () => {
      active = false;
      container.replaceChildren();
    };
  }, [loading, authMode, googleClientId, handleGoogleCredential]);

  useEffect(() => {
    if (loading || authMode !== 'login' || !facebookAppId) return undefined;
    let active = true;
    loadFacebookSdk(facebookAppId).catch((error) => {
      if (active) setAuthError(error.message);
    });
    return () => {
      active = false;
    };
  }, [loading, authMode, facebookAppId]);

  const loadContacts = useCallback(async () => {
    const result = await apiRequest('/api/contacts');
    setContacts(result.contacts);
  }, []);

  const loadCalls = useCallback(async () => {
    const result = await apiRequest('/api/calls');
    setCalls(result.calls);
  }, []);

  const resendVerification = async () => {
    setAuthError('');
    setVerificationUrl('');
    try {
      const result = await apiRequest('/api/auth/verification/resend', {
        method: 'POST',
        body: JSON.stringify({ email: verificationEmail })
      });
      setAuthError(result.message);
      setVerificationUrl(result.developmentVerificationUrl || '');
    } catch (error) {
      setAuthError(error.message);
    }
  };

  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const verificationToken = query.get('verify');
    if (verificationToken) {
      if (verificationStartedRef.current) return undefined;
      verificationStartedRef.current = true;
      apiRequest(`/api/auth/verify?token=${encodeURIComponent(verificationToken)}`)
        .then((result) => {
          setAuthError(result.message);
          setAuthMode('login');
          setVerificationEmail('');
          if (result.user) setUser(result.user);
          window.history.replaceState({}, '', window.location.pathname);
        })
        .catch((error) => setAuthError(error.message))
        .finally(() => setLoading(false));
      return;
    }

    apiRequest('/api/auth/me')
      .then(({ user: currentUser }) => setUser(currentUser))
      .catch((error) => {
        if (!error.message.includes('Sign in is required')) setAuthError(error.message);
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!user) return undefined;
    loadContacts().catch((error) => setAuthError(error.message));

    let disposed = false;
    let retryDelay = 500;
    const connect = () => {
      if (disposed) return;
      setSocketStatus('connecting');
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const socket = new WebSocket(`${protocol}//${window.location.host}/api/signaling`);
      socketRef.current = socket;

      socket.onopen = () => {
        retryDelay = 500;
        setSocketStatus('connected');
      };
      socket.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          setAuthError('The call service sent an invalid message.');
          return;
        }
        handleSignalingMessage(message, setCurrentCall, loadContacts, loadCalls);
        if (message.type === 'error') setAuthError(message.message);
        for (const listener of signalListenersRef.current) listener(message);
      };
      socket.onerror = () => setSocketStatus('error');
      socket.onclose = () => {
        if (disposed) return;
        setSocketStatus('reconnecting');
        reconnectTimerRef.current = window.setTimeout(connect, retryDelay);
        retryDelay = Math.min(retryDelay * 2, 10_000);
      };
    };
    connect();

    return () => {
      disposed = true;
      window.clearTimeout(reconnectTimerRef.current);
      socketRef.current?.close();
      socketRef.current = null;
      setSocketStatus('offline');
    };
  }, [user?.id, loadCalls, loadContacts]);

  const sendSignal = useCallback((type, payload = {}) => {
    const socket = socketRef.current;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      throw new Error('Call service is reconnecting. Please wait and try again.');
    }
    socket.send(JSON.stringify({ type, ...payload }));
  }, []);

  const startCall = useCallback((contact, mode) => {
    if (currentCall) throw new Error('End the active call before starting another.');
    sendSignal('call:invite', { contactId: contact.id, mode });
  }, [currentCall, sendSignal]);

  const acceptCall = useCallback((callId) => {
    sendSignal('call:accept', { callId });
  }, [sendSignal]);

  const declineCall = useCallback((callId) => {
    sendSignal('call:decline', { callId });
    setCurrentCall(null);
  }, [sendSignal]);

  const endCall = useCallback(() => {
    if (!currentCall) return;
    sendSignal(currentCall.status === 'ringing' && currentCall.role === 'caller' ? 'call:cancel' : 'call:end', {
      callId: currentCall.callId
    });
    setCurrentCall(null);
  }, [currentCall, sendSignal]);

  const subscribeSignals = useCallback((listener) => {
    signalListenersRef.current.add(listener);
    return () => signalListenersRef.current.delete(listener);
  }, []);

  const submitAuth = async (event) => {
    event.preventDefault();
    setAuthError('');
    setProviderNotice('');
    setVerificationUrl('');
    setVerificationEmail('');
    const data = new FormData(event.currentTarget);
    const payload = {
      displayName: data.get('displayName'),
      email: data.get('email'),
      password: data.get('password')
    };
    try {
      if (authMode === 'register') {
        const result = await apiRequest('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify(payload)
        });
        setAuthError(result.message);
        setVerificationUrl(result.developmentVerificationUrl || '');
        setVerificationEmail(String(payload.email).trim().toLowerCase());
        setAuthMode('login');
      } else {
        const result = await apiRequest('/api/auth/login', {
          method: 'POST',
          body: JSON.stringify({ email: payload.email, password: payload.password })
        });
        setUser(result.user);
      }
    } catch (error) {
      setAuthError(error.message);
      if (authMode === 'login' && error.message === 'Verify your email before signing in.') {
        setVerificationEmail(String(payload.email).trim().toLowerCase());
      }
    }
  };

  const logout = async () => {
    try {
      if (currentCall) endCall();
      await apiRequest('/api/auth/logout', { method: 'POST' });
      setUser(null);
      setContacts([]);
      setAuthError('');
      setProviderNotice('');
      setVerificationUrl('');
      setVerificationEmail('');
    } catch (error) {
      setAuthError(error.message);
    }
  };

  const contextValue = useMemo(() => ({
    user,
    currentCall,
    socketStatus,
    localVideoStream,
    setLocalVideoStream,
    sendSignal,
    startCall,
    acceptCall,
    declineCall,
    endCall,
    subscribeSignals,
    apiRequest
  }), [
    user, currentCall, socketStatus, localVideoStream, sendSignal, startCall,
    acceptCall, declineCall, endCall, subscribeSignals
  ]);

  if (loading) {
    return <main className="min-h-screen grid place-items-center bg-slate-950 text-cyan-200">Connecting to SignSpeak…</main>;
  }

  if (!user) {
    return (
      <main className="auth-screen">
        <div className="auth-page">
          <aside className="login-sidebar" aria-label="SignSpeak">
            <span>SignSpeak</span>
          </aside>

          <div className="login-background-circle login-circle-a" aria-hidden="true" />
          <div className="login-background-circle login-circle-b" aria-hidden="true" />
          <div className="login-background-circle login-circle-c" aria-hidden="true" />

          {Array.from({ length: 12 }, (_, index) => (
            <span
              key={index}
              className={`login-dot login-dot-${index + 1}`}
              aria-hidden="true"
            />
          ))}

          <form
            onSubmit={submitAuth}
            aria-labelledby="auth-heading"
            className={`login-card${authMode === 'register' ? ' login-card--register' : ''}`}
          >
            <h1 id="auth-heading" className="login-title">
              {authMode === 'register' ? 'Create Account' : 'Login Now'}
            </h1>

            {authMode === 'register' && (
              <input
                className="login-field"
                name="displayName"
                type="text"
                placeholder="Your name"
                aria-label="Display name"
                autoComplete="name"
                minLength={2}
                maxLength={80}
                required
              />
            )}

            <input
              className="login-field"
              name="email"
              type="email"
              placeholder="Email address"
              aria-label="Email address"
              autoComplete="email"
              maxLength={254}
              onChange={(event) => {
                const enteredEmail = event.currentTarget.value.trim().toLowerCase();
                setVerificationEmail((currentEmail) => (
                  currentEmail && currentEmail !== enteredEmail ? '' : currentEmail
                ));
              }}
              required
            />

            <input
              className="login-field"
              name="password"
              type="password"
              placeholder="Password"
              aria-label="Password"
              autoComplete={authMode === 'register' ? 'new-password' : 'current-password'}
              minLength={authMode === 'register' ? 6 : undefined}
              maxLength={128}
              required
            />
            {authMode === 'register' && (
              <span className="login-password-hint">
                Use at least 6 characters: letters, digits, or both (up to 128).
              </span>
            )}

            {authError && (
              <p role="status" aria-live="polite" className="login-error">
                {authError}
              </p>
            )}
            {verificationEmail && authMode === 'login' && (
              <button
                className="login-resend-verification"
                type="button"
                onClick={resendVerification}
              >
                Resend verification link
              </button>
            )}
            {verificationUrl && (
              <a className="login-verification-link" href={verificationUrl}>
                Open verification link (development)
              </a>
            )}

            <button className="login-btn" type="submit">
              {authMode === 'register' ? 'SIGN UP' : 'LOGIN'}
            </button>

            {authMode === 'login' && (
              <>
                <div className="login-or">Or login with</div>
                <div className="login-socials">
                  <button
                    className="login-social login-social-facebook"
                    type="button"
                    onClick={startFacebookSignIn}
                  >
                    <span className="login-social-icon login-facebook-icon" aria-hidden="true">f</span>
                    Facebook
                  </button>
                  {googleClientId ? (
                    <div className="login-google-slot" ref={googleButtonRef} />
                  ) : (
                    <button
                      className="login-social login-social-google"
                      type="button"
                      onClick={() => setProviderNotice(
                        googleClientId === null
                          ? 'Google sign-in is loading.'
                          : 'Google sign-in needs setup. See SOCIAL_SIGN_IN.md.'
                      )}
                    >
                      <span className="login-social-icon login-google-icon" aria-hidden="true">G</span>
                      Google
                    </button>
                  )}
                </div>
                {providerNotice && (
                  <p role="status" className="login-provider-notice">
                    {providerNotice}
                  </p>
                )}
              </>
            )}

            <div className="login-member">
              {authMode === 'login' ? 'Not a member?' : 'Already have an account?'}{' '}
              <button
                type="button"
                onClick={() => {
                  setAuthError('');
                  setProviderNotice('');
                  setVerificationUrl('');
                  setAuthMode(authMode === 'login' ? 'register' : 'login');
                }}
              >
                {authMode === 'login' ? 'Signup now' : 'Sign in'}
              </button>
            </div>
          </form>

          <SignSpeakFlowers />
        </div>
      </main>
    );
  }

  return (
    <AccountContext.Provider value={contextValue}>
      <div className="min-h-screen bg-slate-950 text-slate-100">
        <header className="sticky top-0 z-40 flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 bg-slate-950/95 px-4 py-2.5">
          <div className="min-w-0">
            <p className="truncate font-bold text-cyan-200">{user.displayName}</p>
            <p className="truncate text-xs text-slate-500">{user.email} · {socketStatus}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => {
              const nextVisible = !showContacts;
              setShowContacts(nextVisible);
              setShowHistory(false);
              if (nextVisible) loadContacts().catch((error) => setAuthError(error.message));
            }} className="rounded-lg border border-slate-700 px-3 py-2 text-sm hover:border-cyan-500" aria-expanded={showContacts}>
              Contacts ({contacts.filter((contact) => contact.status === 'accepted').length})
            </button>
            <button type="button" onClick={() => { setShowHistory(!showHistory); setShowContacts(false); if (!showHistory) loadCalls().catch((error) => setAuthError(error.message)); }} className="rounded-lg border border-slate-700 px-3 py-2 text-sm hover:border-cyan-500" aria-expanded={showHistory}>
              Recent calls
            </button>
            <button type="button" onClick={() => { setShowSettings(!showSettings); setShowContacts(false); setShowHistory(false); }} className="rounded-lg border border-slate-700 px-3 py-2 text-sm hover:border-cyan-500" aria-expanded={showSettings}>
              Account
            </button>
            <button type="button" onClick={logout} className="flex items-center gap-1.5 rounded-lg border border-slate-700 px-3 py-2 text-sm hover:border-red-500" aria-label="Sign out">
              <LogOut className="h-4 w-4" /> Sign out
            </button>
          </div>
        </header>

        {authError && (
          <div role="status" aria-live="polite" className="mx-auto mt-3 flex max-w-5xl items-center gap-2 rounded-lg border border-amber-800 bg-amber-950/40 px-4 py-2 text-sm text-amber-200">
            <AlertCircle className="h-4 w-4 shrink-0" /> {authError}
          </div>
        )}

        {showContacts && (
          <section aria-label="Contacts" className="mx-auto my-3 max-w-5xl rounded-xl border border-slate-800 bg-slate-900 p-4">
            <form
              className="flex flex-wrap gap-2"
              onSubmit={async (event) => {
                event.preventDefault();
                setAuthError('');
                const form = event.currentTarget;
                try {
                  await apiRequest('/api/contacts', {
                    method: 'POST',
                    body: JSON.stringify({ email: new FormData(form).get('contactEmail') })
                  });
                  form.reset();
                  await loadContacts();
                } catch (error) {
                  setAuthError(error.message);
                }
              }}
            >
              <label className="sr-only" htmlFor="contact-email">Verified contact email</label>
              <input id="contact-email" name="contactEmail" required type="email" placeholder="Verified SignSpeak account email" className="min-w-64 flex-1 rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" />
              <button type="submit" className="flex items-center gap-2 rounded-lg bg-cyan-700 px-4 py-2 font-semibold hover:bg-cyan-600">
                <UserPlus className="h-4 w-4" /> Invite contact
              </button>
            </form>
            <ul className="mt-3 divide-y divide-slate-800">
              {contacts.map((contact) => (
                <li key={contact.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
                  <div>
                    <p className="font-semibold">{contact.display_name}</p>
                    <p className="text-xs text-slate-500">{contact.email} · {contact.direction} · {contact.status}</p>
                  </div>
                  <div className="flex gap-2">
                    {contact.status === 'accepted' && (
                      <>
                      <button type="button" onClick={() => {
                        try {
                          startCall(contact, 'deaf-to-deaf');
                        } catch (error) {
                          setAuthError(error.message);
                        }
                      }} className="flex items-center gap-1 rounded-lg border border-cyan-700 px-3 py-1.5 text-sm text-cyan-200 hover:bg-cyan-950">
                        <Phone className="h-4 w-4" /> Sign call
                      </button>
                      <button type="button" onClick={() => {
                        try {
                          startCall(contact, 'deaf-to-hearing');
                        } catch (error) {
                          setAuthError(error.message);
                        }
                      }} className="rounded-lg border border-violet-700 px-3 py-1.5 text-sm text-violet-200 hover:bg-violet-950">
                        Sign + speech
                      </button>
                      </>
                    )}
                    {contact.status === 'pending' && contact.direction === 'incoming' && (
                      <>
                      <button type="button" onClick={async () => {
                        try {
                          await apiRequest(`/api/contacts/${contact.id}/accept`, { method: 'POST' });
                          await loadContacts();
                        } catch (error) {
                          setAuthError(error.message);
                        }
                      }} className="rounded-lg border border-emerald-700 px-3 py-1.5 text-sm text-emerald-200">Accept</button>
                      <button type="button" onClick={async () => {
                        try {
                          await apiRequest(`/api/contacts/${contact.id}/decline`, { method: 'POST' });
                          await loadContacts();
                        } catch (error) {
                          setAuthError(error.message);
                        }
                      }} className="rounded-lg border border-slate-700 px-3 py-1.5 text-sm text-slate-300">Decline</button>
                      </>
                    )}
                    <button type="button" aria-label={`Remove ${contact.display_name}`} onClick={async () => {
                      try {
                        await apiRequest(`/api/contacts/${contact.id}`, { method: 'DELETE' });
                        await loadContacts();
                      } catch (error) {
                        setAuthError(error.message);
                      }
                    }} className="rounded-lg border border-slate-700 p-1.5 text-slate-400 hover:text-red-300">
                      <X className="h-4 w-4" />
                    </button>
                  </div>
                </li>
              ))}
              {contacts.length === 0 && <li className="py-4 text-sm text-slate-500">No contacts yet. Invite another verified account.</li>}
            </ul>
          </section>
        )}

        {showSettings && (
          <section aria-label="Account settings" className="mx-auto my-3 grid max-w-5xl gap-4 rounded-xl border border-slate-800 bg-slate-900 p-4 md:grid-cols-2">
            <form className="space-y-3" onSubmit={async (event) => {
              event.preventDefault();
              try {
                const displayName = new FormData(event.currentTarget).get('displayName');
                const result = await apiRequest('/api/profile', {
                  method: 'PATCH',
                  body: JSON.stringify({ displayName })
                });
                setUser(result.user);
              } catch (error) {
                setAuthError(error.message);
              }
            }}>
              <h2 className="font-bold">Profile</h2>
              <label className="block text-sm text-slate-300">
                Display name
                <input name="displayName" required minLength={2} maxLength={80} defaultValue={user.displayName} className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" />
              </label>
              <p className="text-sm text-slate-500">{user.email} · email verified</p>
              <button type="submit" className="rounded-lg bg-cyan-700 px-4 py-2 font-semibold">Save profile</button>
            </form>
            <form className="space-y-3 border-t border-red-950 pt-3 md:border-l md:border-t-0 md:pl-4 md:pt-0" onSubmit={async (event) => {
              event.preventDefault();
              const form = event.currentTarget;
              const data = new FormData(form);
              if (data.get('confirmation') !== 'DELETE') {
                setAuthError('Type DELETE exactly to confirm account deletion.');
                return;
              }
              try {
                await apiRequest('/api/account', {
                  method: 'DELETE',
                  body: JSON.stringify({ password: data.get('password') })
                });
                setUser(null);
                setContacts([]);
                setCalls([]);
                setShowSettings(false);
              } catch (error) {
                setAuthError(error.message);
              }
            }}>
              <h2 className="font-bold text-red-300">Delete account</h2>
              <label className="block text-sm text-slate-300">
                Account password
                <input name="password" type="password" required autoComplete="current-password" className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" />
              </label>
              <label className="block text-sm text-slate-300">
                Type DELETE to confirm
                <input name="confirmation" required className="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2" />
              </label>
              <button type="submit" className="rounded-lg border border-red-800 px-4 py-2 text-red-200">Delete my account</button>
            </form>
          </section>
        )}

        {showHistory && (
          <section aria-label="Recent calls" className="mx-auto my-3 max-w-5xl rounded-xl border border-slate-800 bg-slate-900 p-4">
            <div className="flex items-center justify-between">
              <h2 className="font-bold">Recent calls (up to 3)</h2>
              <button type="button" onClick={async () => {
                try {
                  await apiRequest('/api/calls', { method: 'DELETE' });
                  setCalls([]);
                } catch (error) {
                  setAuthError(error.message);
                }
              }} className="text-sm text-slate-400 underline">Clear history</button>
            </div>
            {calls.map((call) => (
              <p key={call.id} className="border-t border-slate-800 py-2 text-sm">
                {call.participant} · {call.status} · {new Date(call.created_at).toLocaleString()}
              </p>
            ))}
            {calls.length === 0 && <p className="mt-2 text-sm text-slate-500">No recent calls.</p>}
          </section>
        )}

        {children}
        {currentCall && <CallPanel />}
      </div>
    </AccountContext.Provider>
  );
}

function CallPanel() {
  const {
    user, currentCall, acceptCall, declineCall, endCall, sendSignal,
    subscribeSignals, localVideoStream, apiRequest
  } = useAccount();
  const localVideoRef = useRef(null);
  const remoteVideoRef = useRef(null);
  const peerConnectionRef = useRef(null);
  const mediaStreamRef = useRef(null);
  const remoteStreamRef = useRef(new MediaStream());
  const queuedCandidatesRef = useRef([]);
  const [remoteCaptions, setRemoteCaptions] = useState([]);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatText, setChatText] = useState('');
  const [callError, setCallError] = useState('');
  const [mirror, setMirror] = useState(true);
  const [muted, setMuted] = useState(false);
  const [cameraEnabled, setCameraEnabled] = useState(true);
  const [speechCaptions, setSpeechCaptions] = useState(false);
  const [iceConfig, setIceConfig] = useState(null);
  const [consentRequested, setConsentRequested] = useState(false);
  const [ownConsent, setOwnConsent] = useState(false);
  const [remoteConsentRequested, setRemoteConsentRequested] = useState(false);
  const [recordingConsents, setRecordingConsents] = useState({});
  const recognitionRef = useRef(null);
  const call = currentCall;
  const isIncoming = call.role === 'callee' && call.status === 'ringing';
  const isConnecting = ['connecting', 'connected', 'reconnecting'].includes(call.status);

  useEffect(() => {
    if (localVideoRef.current && mediaStreamRef.current) {
      localVideoRef.current.srcObject = mediaStreamRef.current;
      localVideoRef.current.play().catch((error) => setCallError(`Local preview failed: ${error.message}`));
    }
    if (remoteVideoRef.current && remoteStreamRef.current.getTracks().length) {
      remoteVideoRef.current.srcObject = remoteStreamRef.current;
      remoteVideoRef.current.play().catch((error) => setCallError(`Remote video failed: ${error.message}`));
    }
  }, [call.status, cameraEnabled, mirror]);

  useEffect(() => {
    if (!isConnecting) return undefined;
    let disposed = false;
    let unsubscribe = () => {};
    let localStream;
    let audioStream;
    let videoCaptureStream;
    let clonedVideoTracks = [];
    const remoteStream = remoteStreamRef.current;

    const connectPeer = async () => {
      try {
        const { iceServers } = await apiRequest('/api/calls/ice-config');
        if (disposed) return;
        setIceConfig(iceServers);
        audioStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        if (disposed) {
          audioStream.getTracks().forEach((track) => track.stop());
          return;
        }
        let videoTracks = localVideoStream?.getVideoTracks() || [];
        if (videoTracks.length) {
          clonedVideoTracks = videoTracks.map((track) => track.clone());
        } else {
          videoCaptureStream = await navigator.mediaDevices.getUserMedia({ audio: false, video: true });
          videoTracks = videoCaptureStream.getVideoTracks();
        }
        const callVideoTracks = clonedVideoTracks.length ? clonedVideoTracks : videoTracks;
        localStream = new MediaStream([...callVideoTracks, ...audioStream.getAudioTracks()]);
        if (disposed) {
          localStream.getTracks().forEach((track) => track.stop());
          return;
        }
        mediaStreamRef.current = localStream;
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = localStream;
          localVideoRef.current.play().catch((error) => setCallError(`Local preview failed: ${error.message}`));
        }
        const peerConnection = new RTCPeerConnection({ iceServers });
        peerConnectionRef.current = peerConnection;
        for (const track of localStream.getTracks()) peerConnection.addTrack(track, localStream);
        peerConnection.onicecandidate = ({ candidate }) => {
          if (!candidate) return;
          try {
            sendSignal('webrtc:ice', { callId: call.callId, candidate: candidate.toJSON() });
          } catch (error) {
            peerConnectionRef.current?.close();
            peerConnectionRef.current = null;
            localStream?.getTracks().forEach((track) => track.stop());
            mediaStreamRef.current = null;
            audioStream?.getTracks().forEach((track) => track.stop());
            videoCaptureStream?.getTracks().forEach((track) => track.stop());
            clonedVideoTracks.forEach((track) => track.stop());
            if (!disposed) setCallError(error.message);
          }
        };
        peerConnection.ontrack = ({ track }) => {
          if (!remoteStream.getTracks().some((existingTrack) => existingTrack.id === track.id)) {
            remoteStream.addTrack(track);
          }
          if (remoteVideoRef.current) {
            remoteVideoRef.current.srcObject = remoteStream;
            remoteVideoRef.current.play().catch((error) => setCallError(`Remote video failed: ${error.message}`));
          }
        };
        peerConnection.onconnectionstatechange = () => {
          if (peerConnection.connectionState === 'failed') setCallError('The network connection failed. Check your connection and end or retry the call.');
          if (peerConnection.connectionState === 'disconnected') setCallError('Connection interrupted. Attempting to reconnect…');
          if (peerConnection.connectionState === 'connected') {
            setCallError('');
            try {
              sendSignal('call:ready', { callId: call.callId });
            } catch (error) {
              setCallError(error.message);
            }
          }
        };

        unsubscribe = subscribeSignals(async (message) => {
          if (message.callId !== call.callId) return;
          try {
            if (message.type === 'webrtc:offer' && call.role === 'callee') {
              await peerConnection.setRemoteDescription(message.description);
              for (const candidate of queuedCandidatesRef.current.splice(0)) {
                await peerConnection.addIceCandidate(candidate);
              }
              const answer = await peerConnection.createAnswer();
              await peerConnection.setLocalDescription(answer);
              sendSignal('webrtc:answer', { callId: call.callId, description: peerConnection.localDescription });
            } else if (message.type === 'webrtc:answer' && call.role === 'caller') {
              await peerConnection.setRemoteDescription(message.description);
              for (const candidate of queuedCandidatesRef.current.splice(0)) {
                await peerConnection.addIceCandidate(candidate);
              }
            } else if (message.type === 'webrtc:ice') {
              if (peerConnection.remoteDescription) await peerConnection.addIceCandidate(message.candidate);
              else queuedCandidatesRef.current.push(message.candidate);
            } else if (message.type === 'caption') {
              setRemoteCaptions((previous) => [...previous.slice(-19), message]);
            } else if (message.type === 'chat:message') {
              setChatMessages((previous) => [...previous.slice(-49), message]);
            } else if (message.type === 'recording:consent') {
              setRecordingConsents((previous) => ({ ...previous, [message.userId]: message.consent }));
              if (message.userId === user.id) setOwnConsent(message.consent === 'accepted');
              if (message.userId !== user.id) setConsentRequested(false);
            } else if (message.type === 'recording:request') {
              setRemoteConsentRequested(true);
            } else if (message.type === 'call:reconnecting') {
              setCallError('The other participant is reconnecting…');
            }
          } catch (error) {
            setCallError(`Call connection error: ${error.message}`);
          }
        });

        if (call.role === 'caller') {
          const offer = await peerConnection.createOffer();
          await peerConnection.setLocalDescription(offer);
          sendSignal('webrtc:offer', { callId: call.callId, description: peerConnection.localDescription });
        }
      } catch (error) {
        setCallError(error.message);
      }
    };

    connectPeer();
    return () => {
      disposed = true;
      unsubscribe();
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      peerConnectionRef.current?.close();
      peerConnectionRef.current = null;
      mediaStreamRef.current?.getTracks().forEach((track) => track.stop());
      mediaStreamRef.current = null;
      remoteStream.getTracks().forEach((track) => {
        remoteStream.removeTrack(track);
      });
      remoteVideoRef.current && (remoteVideoRef.current.srcObject = null);
      localVideoRef.current && (localVideoRef.current.srcObject = null);
    };
  }, [isConnecting, call.callId, call.role, localVideoStream, sendSignal, subscribeSignals, apiRequest, setLocalVideoStream]);

  useEffect(() => {
    if (!isConnecting || !speechCaptions) {
      recognitionRef.current?.stop();
      recognitionRef.current = null;
      return undefined;
    }
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!Recognition) {
      setCallError('Speech recognition is not supported in this browser.');
      setSpeechCaptions(false);
      return undefined;
    }
    const recognition = new Recognition();
    recognition.lang = navigator.language || 'en-US';
    recognition.continuous = true;
    recognition.interimResults = false;
    recognition.onresult = (event) => {
      const result = event.results[event.results.length - 1];
      if (result?.isFinal && result[0]?.transcript) {
        sendSignal('caption', {
          callId: call.callId,
          text: result[0].transcript.slice(0, 1000),
          source: 'speech'
        });
      }
    };
    recognition.onerror = (event) => setCallError(`Speech captions unavailable: ${event.error}`);
    recognitionRef.current = recognition;
    recognition.start();
    return () => recognition.stop();
  }, [isConnecting, speechCaptions, call.callId, sendSignal]);

  const submitChat = (event) => {
    event.preventDefault();
    const text = chatText.trim();
    if (!text) return;
    try {
      sendSignal('chat:message', { callId: call.callId, text });
      setChatMessages((previous) => [...previous.slice(-49), { text, senderId: 'self', createdAt: Date.now() }]);
      setChatText('');
    } catch (error) {
      setCallError(error.message);
    }
  };

  const toggleRecordingConsent = () => {
    try {
      if (consentRequested) return;
      sendSignal('recording:request', { callId: call.callId });
      setConsentRequested(true);
    } catch (error) {
      setCallError(error.message);
    }
  };

  const revokeRecordingConsent = () => {
    try {
      sendSignal('recording:consent', { callId: call.callId, consent: 'withdrawn' });
      setOwnConsent(false);
    } catch (error) {
      setCallError(error.message);
    }
  };

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="call-title" className="fixed inset-0 z-50 overflow-y-auto bg-slate-950/95 p-3 text-slate-100">
      <div className="mx-auto flex min-h-full max-w-6xl flex-col gap-3">
        <header className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-3">
          <div>
            <h2 id="call-title" className="text-xl font-bold">Call with {call.peer?.displayName || call.peer?.display_name || 'SignSpeak contact'}</h2>
            <p role="status" aria-live="polite" className="text-sm text-cyan-300">{call.status} · {call.mode === 'deaf-to-hearing' ? 'Deaf-to-hearing' : 'Deaf-to-deaf'}</p>
          </div>
          <button type="button" onClick={() => {
            try {
              endCall();
            } catch (error) {
              setCallError(error.message);
            }
          }} className="rounded-lg bg-red-700 px-4 py-2 font-bold hover:bg-red-600">End call</button>
        </header>

        {isIncoming && (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-cyan-700 bg-cyan-950/50 p-4">
            <p className="flex-1">{call.peer?.displayName || 'Your contact'} is calling.</p>
            <button type="button" onClick={() => {
              try {
                acceptCall(call.callId);
              } catch (error) {
                setCallError(error.message);
              }
            }} className="rounded-lg bg-emerald-700 px-4 py-2 font-bold">Accept</button>
            <button type="button" onClick={() => declineCall(call.callId)} className="rounded-lg bg-red-800 px-4 py-2 font-bold">Decline</button>
          </div>
        )}

        {callError && <p role="alert" className="rounded-lg border border-amber-700 bg-amber-950/40 p-3 text-amber-200">{callError}</p>}

        {isConnecting && (
          <>
            <div className="grid flex-1 gap-3 md:grid-cols-2">
              <div className="relative min-h-56 overflow-hidden rounded-xl border border-slate-700 bg-black">
                <video ref={localVideoRef} muted autoPlay playsInline className={`h-full w-full object-cover ${mirror ? '-scale-x-100' : ''}`} />
                <span className="absolute bottom-2 left-2 rounded bg-black/70 px-2 py-1 text-xs">You</span>
              </div>
              <div className="relative min-h-56 overflow-hidden rounded-xl border border-slate-700 bg-black">
                <video ref={remoteVideoRef} autoPlay playsInline className="h-full w-full object-cover" />
                <span className="absolute bottom-2 left-2 rounded bg-black/70 px-2 py-1 text-xs">{call.peer?.displayName || 'Contact'}</span>
              </div>
            </div>

            <div className="grid gap-3 lg:grid-cols-[1fr_20rem]">
              <section aria-label="Live captions" className="rounded-xl border border-slate-800 bg-slate-900 p-3">
                <h3 className="font-bold">Live captions</h3>
                <div className="mt-2 max-h-36 space-y-1 overflow-y-auto" aria-live="polite">
                  {remoteCaptions.slice(-8).map((caption, index) => (
                    <p key={`${caption.createdAt || index}-${index}`} className={caption.senderId === 'self' ? 'text-right text-cyan-200' : 'text-left text-white'}>
                      <span className="mr-1 text-[10px] uppercase text-slate-500">{caption.source === 'speech' ? 'Speech' : caption.senderId === 'self' ? 'You' : call.peer?.displayName || 'Contact'}</span>
                      {caption.text}
                    </p>
                  ))}
                  {remoteCaptions.length === 0 && <p className="text-sm text-slate-500">Recognized signs will appear here for both participants.</p>}
                </div>
              </section>
              <section aria-label="Call controls" className="flex flex-wrap items-start gap-2 rounded-xl border border-slate-800 bg-slate-900 p-3">
                <button type="button" onClick={() => {
                  const nextMuted = !muted;
                  mediaStreamRef.current?.getAudioTracks().forEach((track) => { track.enabled = !nextMuted; });
                  setMuted(nextMuted);
                }} aria-pressed={muted} className="rounded-lg border border-slate-700 px-3 py-2 text-sm">{muted ? 'Unmute mic' : 'Mute mic'}</button>
                <button type="button" onClick={() => {
                  const nextEnabled = !cameraEnabled;
                  mediaStreamRef.current?.getVideoTracks().forEach((track) => { track.enabled = nextEnabled; });
                  setCameraEnabled(nextEnabled);
                }} aria-pressed={cameraEnabled} className="rounded-lg border border-slate-700 px-3 py-2 text-sm">{cameraEnabled ? 'Camera off' : 'Camera on'}</button>
                <button type="button" onClick={() => setMirror(!mirror)} aria-pressed={mirror} className="rounded-lg border border-slate-700 px-3 py-2 text-sm">Mirror {mirror ? 'on' : 'off'}</button>
                {call.mode === 'deaf-to-hearing' && (
                  <button type="button" onClick={() => setSpeechCaptions(!speechCaptions)} aria-pressed={speechCaptions} className="rounded-lg border border-slate-700 px-3 py-2 text-sm">Speech captions {speechCaptions ? 'on' : 'off'}</button>
                )}
                <button type="button" onClick={() => {
                  if (!('speechSynthesis' in window)) {
                    setCallError('Text-to-speech is not supported in this browser.');
                    return;
                  }
                  const latest = remoteCaptions[remoteCaptions.length - 1]?.text;
                  if (latest) window.speechSynthesis.speak(new SpeechSynthesisUtterance(latest));
                }} className="rounded-lg border border-slate-700 px-3 py-2 text-sm">Speak latest caption</button>
                <button type="button" onClick={toggleRecordingConsent} disabled={consentRequested} className="rounded-lg border border-amber-700 px-3 py-2 text-sm disabled:opacity-50">
                  {consentRequested ? 'Recording requested' : 'Request recording'}
                </button>
                {ownConsent && <button type="button" onClick={revokeRecordingConsent} className="rounded-lg border border-amber-700 px-3 py-2 text-sm">Withdraw consent</button>}
                {remoteConsentRequested && (
                  <div className="flex w-full flex-wrap items-center gap-2 text-xs text-amber-200">
                    <span>Your contact requested recording. Recording is not enabled in this release.</span>
                    <button type="button" onClick={() => {
                      try {
                        sendSignal('recording:consent', { callId: call.callId, consent: 'accepted' });
                        setOwnConsent(true);
                        setRemoteConsentRequested(false);
                      } catch (error) {
                        setCallError(error.message);
                      }
                    }} className="rounded border border-amber-600 px-2 py-1">Consent</button>
                    <button type="button" onClick={() => {
                      try {
                        sendSignal('recording:consent', { callId: call.callId, consent: 'declined' });
                        setRemoteConsentRequested(false);
                      } catch (error) {
                        setCallError(error.message);
                      }
                    }} className="rounded border border-slate-600 px-2 py-1">Decline</button>
                  </div>
                )}
                {Object.values(recordingConsents).filter((value) => value === 'accepted').length > 0 && (
                  <p className="w-full text-xs text-amber-200">Consent received. Recording is not enabled in this release.</p>
                )}
                {!iceConfig && <p className="w-full text-xs text-slate-500">Waiting for secure ICE server configuration…</p>}
              </section>
            </div>

            <form onSubmit={submitChat} className="flex gap-2">
              <label className="sr-only" htmlFor="call-chat">Text chat</label>
              <input id="call-chat" value={chatText} onChange={(event) => setChatText(event.target.value)} maxLength={1000} placeholder="Text chat fallback" className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-2" />
              <button type="submit" className="rounded-lg bg-cyan-700 px-4 py-2 font-bold">Send</button>
            </form>
            <div className="max-h-24 overflow-y-auto text-sm text-slate-300">
              {chatMessages.slice(-5).map((message, index) => <p key={`${message.createdAt || index}-${index}`}>{message.text}</p>)}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function handleSignalingMessage(message, setCurrentCall, loadContacts, loadCalls) {
  if (message.type === 'call:incoming') {
    setCurrentCall({ callId: message.callId, role: 'callee', status: 'ringing', mode: message.mode, peer: message.caller });
  } else if (message.type === 'call:outgoing') {
    setCurrentCall({ callId: message.callId, role: 'caller', status: message.status, mode: message.mode });
  } else if (message.type === 'call:accepted') {
    setCurrentCall((current) => current?.callId === message.callId
      ? { ...current, status: 'connecting', peer: message.peer, mode: message.mode }
      : current);
  } else if (message.type === 'call:state') {
    setCurrentCall((current) => current?.callId === message.callId
      ? { ...current, status: message.status }
      : current);
    if (['missed', 'declined', 'ended'].includes(message.status)) {
      setTimeout(() => setCurrentCall((current) => current?.callId === message.callId ? null : current), 2500);
      loadCalls().catch(() => {});
    }
  } else if (message.type === 'call:declined' || message.type === 'call:ended') {
    setCurrentCall((current) => current?.callId === message.callId
      ? { ...current, status: message.status || 'declined' }
      : current);
    setTimeout(() => setCurrentCall((current) => current?.callId === message.callId ? null : current), 2500);
    loadCalls().catch(() => {});
  } else if (message.type === 'call:reconnecting') {
    setCurrentCall((current) => current?.callId === message.callId ? { ...current, status: 'reconnecting' } : current);
  } else if (message.type === 'contact:updated') {
    loadContacts().catch(() => {});
  }
}
