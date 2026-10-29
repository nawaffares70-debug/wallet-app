import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { io } from 'socket.io-client';
import TransfersView from './TransfersView.jsx';

let root;
let currentProps = { currentUser: null, initialView: 'main' };

function renderTransfers(nextProps = {}) {
  currentProps = { ...currentProps, ...nextProps };
  const target = document.getElementById('transfersReactRoot');
  if (!target) return;
  root ||= createRoot(target);
  root.render(
    <TransfersView
      key={currentProps.initialView}
      currentUser={currentProps.currentUser}
      initialView={currentProps.initialView}
      onBack={currentProps.onBack}
    />,
  );
}

window.mountTransfersView = (props = {}) => renderTransfers(props);
window.openTransfersView = (view = 'main') => renderTransfers({ initialView: view });

function playNotificationSound() {
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;

    const context = new AudioContextClass();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = 'sine';
    oscillator.frequency.setValueAtTime(880, context.currentTime);
    oscillator.frequency.exponentialRampToValueAtTime(1320, context.currentTime + 0.12);
    gain.gain.setValueAtTime(0.0001, context.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.2, context.currentTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.35);
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    oscillator.stop(context.currentTime + 0.35);
    oscillator.addEventListener('ended', () => context.close());
  } catch (error) {
    // قد تمنع سياسات المتصفح الصوت قبل أول تفاعل للمستخدم
  }
}

function NotificationCenter({ currentUser }) {
  const [toast, setToast] = useState(null);
  const [connectionStatus, setConnectionStatus] = useState('idle');
  const hasConnectedRef = useRef(false);
  const statusTimerRef = useRef(null);
  const [permission, setPermission] = useState(
    typeof window !== 'undefined' && 'Notification' in window ? Notification.permission : 'unsupported',
  );
  const userId = currentUser?.user?.id || currentUser?.id;
  const accountId = currentUser?.account?.id;

  const showNotification = useCallback(({ title, message, transactionId }) => {
    setToast({ id: Date.now(), title, message });
    playNotificationSound();

    if (typeof window === 'undefined' || !('Notification' in window) || Notification.permission !== 'granted') {
      return;
    }

    const notificationOptions = {
        body: message,
        dir: 'rtl',
        lang: 'ar',
        tag: `${transactionId ? `transfer-${transactionId}` : 'wallet-notification'}-${Date.now()}`,
    };
    const showFallbackNotification = () => {
      try {
        const browserNotification = new Notification(title, notificationOptions);
        browserNotification.onclick = () => window.focus();
      } catch (error) {
        // يبقى Toast الداخلي ظاهرًا حتى لو منع المتصفح إنشاء إشعار خارجي
      }
    };

    if (window.notificationServiceWorkerReady) {
      window.notificationServiceWorkerReady
        .then((registration) => registration.showNotification(title, notificationOptions))
        .catch(showFallbackNotification);
    } else {
      showFallbackNotification();
    }
  }, []);

  useEffect(() => {
    if (!userId || typeof window === 'undefined') return undefined;

    if (!('Notification' in window)) {
      setPermission('unsupported');
    } else {
      setPermission(Notification.permission);
    }

    const token = window.localStorage.getItem('token');
    if (!token) {
      setConnectionStatus('disconnected');
      return undefined;
    }

    const clearStatusTimer = () => {
      if (statusTimerRef.current) {
        window.clearTimeout(statusTimerRef.current);
        statusTimerRef.current = null;
      }
    };

    const showTemporaryStatus = (status, duration = 2200) => {
      clearStatusTimer();
      setConnectionStatus(status);
      statusTimerRef.current = window.setTimeout(() => {
        setConnectionStatus('idle');
        statusTimerRef.current = null;
      }, duration);
    };

    setConnectionStatus('connecting');
    const socket = io(window.location.origin, {
      path: '/socket.io',
      auth: { token, userId, accountId },
      transports: ['websocket', 'polling'],
      withCredentials: false,
      autoConnect: true,
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 500,
      reconnectionDelayMax: 5000,
      timeout: 20000,
    });
    const onConnect = () => {
      const wasReconnecting = hasConnectedRef.current;
      const wasRecovered = socket.recovered;
      hasConnectedRef.current = true;
      showTemporaryStatus(wasRecovered || wasReconnecting ? 'recovered' : 'connected');
    };
    const onDisconnect = () => {
      clearStatusTimer();
      setConnectionStatus('disconnected');
    };
    const onReconnectAttempt = () => {
      clearStatusTimer();
      setConnectionStatus('reconnecting');
    };
    const onConnectError = () => {
      clearStatusTimer();
      setConnectionStatus('reconnecting');
    };
    const sendTransfer = (payload = {}, acknowledge) => {
      socket.emit('send_transfer', payload, acknowledge);
    };

    window.sendTransferNotification = sendTransfer;
    socket.on('connect', onConnect);
    socket.on('disconnect', onDisconnect);
    socket.on('connect_error', onConnectError);
    socket.io.on('reconnect_attempt', onReconnectAttempt);

    const onTransferReceived = (payload = {}) => {
      const amount = payload.amount ?? '—';
      const currency = payload.currency || '';
      const sender = payload.senderName || 'مشترك';
      const message = payload.message || `تم استلام حوالة جديدة بقيمة ${amount} ${currency} من ${sender}`;
      showNotification({
        title: 'حوالة جديدة',
        message,
        transactionId: payload.transactionId,
      });
    };

    const onTransferSent = (payload = {}) => {
      const receiver = payload.receiverName || 'المستلم';
      const message = payload.message || `تم إرسال المبلغ بنجاح إلى ${receiver}`;
      showNotification({
        title: 'تم التحويل بنجاح',
        message,
        transactionId: payload.transactionId,
      });
    };

    socket.on('transfer:received', onTransferReceived);
    socket.on('transfer:sent', onTransferSent);
    return () => {
      clearStatusTimer();
      if (window.sendTransferNotification === sendTransfer) {
        delete window.sendTransferNotification;
      }
      socket.off('transfer:received', onTransferReceived);
      socket.off('transfer:sent', onTransferSent);
      socket.off('connect', onConnect);
      socket.off('disconnect', onDisconnect);
      socket.off('connect_error', onConnectError);
      socket.io.off('reconnect_attempt', onReconnectAttempt);
      socket.disconnect();
      hasConnectedRef.current = false;
      setConnectionStatus('idle');
    };
  }, [accountId, showNotification, userId]);

  const handleEnableNotifications = () => {
    if (typeof window === 'undefined' || !('Notification' in window)) {
      setPermission('unsupported');
      return;
    }

    if (Notification.permission === 'granted') {
      setPermission('granted');
      return;
    }

    Notification.requestPermission()
      .then((result) => setPermission(result))
      .catch(() => setPermission('denied'));
  };

  const handleTestNotification = () => {
    showNotification({
      title: 'تجربة الإشعار',
      message: 'هذا إشعار تجريبي للتأكد من عمل الصوت والتنبيهات.',
    });
  };

  useEffect(() => {
    if (!toast) return undefined;
    const timer = window.setTimeout(() => setToast(null), 7000);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const connectionStatusCopy = {
    connecting: {
      label: 'جاري الاتصال بإشعارات التحويل…',
      tone: 'connecting',
    },
    connected: {
      label: 'إشعارات التحويل متصلة',
      tone: 'connected',
    },
    reconnecting: {
      label: 'جاري استعادة إشعارات التحويل…',
      tone: 'reconnecting',
    },
    disconnected: {
      label: 'انقطعت إشعارات التحويل — ستتم إعادة المحاولة تلقائيًا',
      tone: 'disconnected',
    },
    recovered: {
      label: 'تمت استعادة إشعارات التحويل',
      tone: 'connected',
    },
  }[connectionStatus];

  return (
    <>
      {currentUser && (
        <div style={notificationStyles.permissionBar}>
          {connectionStatusCopy && (
            <div
              style={{
                ...notificationStyles.connectionStatus,
                ...notificationStyles.connectionStatusTones[connectionStatusCopy.tone],
              }}
              role="status"
              aria-live="polite"
            >
              <span style={notificationStyles.connectionDot} aria-hidden="true" />
              <span>{connectionStatusCopy.label}</span>
            </div>
          )}
          <div style={notificationStyles.permissionActions}>
            {permission === 'granted' ? (
              <span style={notificationStyles.enabledLabel} role="status">
                الإشعارات مفعّلة ✅
              </span>
            ) : (
              <button
                type="button"
                style={notificationStyles.enableButton}
                onClick={handleEnableNotifications}
              >
                تفعيل الإشعارات 🔔
              </button>
            )}
            <button
              type="button"
              style={notificationStyles.testButton}
              onClick={handleTestNotification}
            >
              تجربة الإشعار 🔔
            </button>
          </div>
        </div>
      )}

      {toast && (
        <div style={notificationStyles.container} role="status" aria-live="polite">
          <div style={notificationStyles.toast}>
            <div style={notificationStyles.icon} aria-hidden="true">✓</div>
            <div style={notificationStyles.copy}>
              <strong>{toast.title}</strong>
              <span>{toast.message}</span>
              {permission !== 'granted' && <small style={notificationStyles.copySmall}>إشعارات المتصفح غير مفعّلة — يظهر هذا التنبيه داخل التطبيق.</small>}
            </div>
            <button type="button" style={notificationStyles.close} onClick={() => setToast(null)} aria-label="إغلاق الإشعار">×</button>
          </div>
        </div>
      )}
    </>
  );
}

const notificationStyles = {
  permissionBar: {
    width: '100%',
    maxWidth: '430px',
    margin: '12px auto 0',
    padding: '0 16px',
    display: 'flex',
    justifyContent: 'flex-start',
    direction: 'rtl',
  },
  permissionActions: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap',
  },
  connectionStatus: {
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginBottom: '8px',
    padding: '9px 12px',
    border: '1px solid',
    borderRadius: '12px',
    fontSize: '12px',
    fontWeight: '800',
    lineHeight: 1.4,
  },
  connectionStatusTones: {
    connecting: {
      borderColor: '#60a5fa',
      background: '#172554',
      color: '#dbeafe',
    },
    connected: {
      borderColor: '#22c55e',
      background: '#14532d',
      color: '#dcfce7',
    },
    reconnecting: {
      borderColor: '#fbbf24',
      background: '#78350f',
      color: '#fef3c7',
    },
    disconnected: {
      borderColor: '#f87171',
      background: '#7f1d1d',
      color: '#fee2e2',
    },
  },
  connectionDot: {
    flex: '0 0 auto',
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    backgroundColor: 'currentColor',
  },
  enableButton: {
    border: '1px solid #fbbf24',
    borderRadius: '12px',
    padding: '9px 14px',
    background: '#78350f',
    color: '#fef3c7',
    fontSize: '13px',
    fontWeight: '800',
    cursor: 'pointer',
    boxShadow: '0 6px 18px rgba(0, 0, 0, .2)',
  },
  testButton: {
    border: '1px solid #60a5fa',
    borderRadius: '12px',
    padding: '9px 14px',
    background: '#172554',
    color: '#dbeafe',
    fontSize: '13px',
    fontWeight: '800',
    cursor: 'pointer',
    boxShadow: '0 6px 18px rgba(0, 0, 0, .2)',
  },
  enabledLabel: {
    border: '1px solid #22c55e',
    borderRadius: '12px',
    padding: '9px 14px',
    background: '#14532d',
    color: '#dcfce7',
    fontSize: '13px',
    fontWeight: '800',
  },
  container: {
    position: 'fixed',
    top: '16px',
    right: '16px',
    left: '16px',
    zIndex: 11000,
    display: 'flex',
    justifyContent: 'center',
    pointerEvents: 'none',
    direction: 'rtl',
  },
  toast: {
    width: '100%',
    maxWidth: '430px',
    display: 'flex',
    alignItems: 'flex-start',
    gap: '10px',
    padding: '14px',
    border: '1px solid #22c55e',
    borderRadius: '16px',
    background: 'linear-gradient(135deg, #052e16, #14532d)',
    color: '#ffffff',
    boxShadow: '0 14px 36px rgba(0, 0, 0, .35)',
    pointerEvents: 'auto',
  },
  icon: {
    flex: '0 0 auto',
    width: '30px',
    height: '30px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '50%',
    backgroundColor: '#22c55e',
    color: '#052e16',
    fontSize: '18px',
    fontWeight: '900',
  },
  copy: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
    flex: 1,
    fontSize: '13px',
    lineHeight: 1.5,
  },
  copySmall: {
    color: '#bbf7d0',
    fontSize: '11px',
  },
  close: {
    flex: '0 0 auto',
    border: 'none',
    background: 'transparent',
    color: '#bbf7d0',
    fontSize: '22px',
    lineHeight: 1,
    cursor: 'pointer',
  },
};

let notificationsRoot;
let notificationsProps = { currentUser: null };

function renderNotifications(nextProps = {}) {
  notificationsProps = { ...notificationsProps, ...nextProps };
  const target = document.getElementById('notificationsReactRoot');
  if (!target) return;
  notificationsRoot ||= createRoot(target);
  notificationsRoot.render(<NotificationCenter currentUser={notificationsProps.currentUser} />);
}

window.mountNotifications = (props = {}) => renderNotifications(props);