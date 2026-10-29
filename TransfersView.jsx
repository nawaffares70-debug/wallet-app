import React, { useEffect, useMemo, useRef, useState } from 'react';

const LOCAL_NETWORKS = [
  ['hazmi', 'حزمي تحويل', '#10172a', '#ef4444'],
  ['jeeb', 'حوالات جيب', '#be123c', '#fecdd3'],
  ['dadiyah', 'شبكة دادية', '#1e3a8a', '#dbeafe'],
  ['alimtiaz', 'شبكة الامتياز', '#b45309', '#fef3c7'],
  ['alnajm', 'شبكة النجم', '#c2410c', '#ffedd5'],
  ['yemen_express', 'شبكة يمن اكسبرس', '#047857', '#d1fae5'],
  ['hb_fast', 'شبكة الحوشبي (إتش بي)', '#0369a1', '#e0f2fe'],
  ['almomayaz', 'شبكة المميز', '#a21caf', '#fae8ff'],
  ['alakwaa', 'شبكة الأكوع', '#0d9488', '#ccfbf1'],
  ['yemeni_network', 'الشبكة اليمنية للتحويلات', '#4338ca', '#e0e7ff'],
  ['alsaifi', 'الصيفي كاش', '#1d4ed8', '#dbeafe'],
  ['alhattar', 'شبكة الهتار', '#b45309', '#fef3c7'],
  ['mall_money', 'شبكة مال موني', '#15803d', '#dcfce7'],
  ['barq', 'شبكة البرق', '#c2410c', '#ffedd5'],
  ['alsarea', 'السريع للحوالات', '#0369a1', '#e0f2fe'],
  ['nasser', 'شبكة الناصر', '#1d4ed8', '#dbeafe'],
  ['almoheet', 'شبكة المحيط', '#0369a1', '#e0f2fe'],
  ['alamri', 'شبكة العامري كاش', '#1e3a8a', '#dbeafe'],
  ['yeah_money', 'ياه موني', '#0284c7', '#e0f2fe'],
].map(([id, name, color, bg]) => ({ id, name, color, bg }));

const EMPTY_MESSAGE = { type: '', text: '' };
const PUBLIC_ACCOUNT_PATTERN = /^7\d{8}$/;

async function request(path, options = {}) {
  const token = window.localStorage.getItem('token');
  const response = await fetch(path, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(options.headers || {}),
    },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'تعذر إكمال العملية');
  return data;
}

function currencyLabel(currency) {
  return { YER: 'ريال يمني', SAR: 'ريال سعودي', USD: 'دولار أمريكي' }[currency] || currency;
}

function firstValue(source, keys, fallback = '—') {
  const value = keys.map((key) => source?.[key]).find((candidate) => candidate !== undefined && candidate !== null && String(candidate).trim() !== '');
  return value ?? fallback;
}

function formatVoucherDate(value = new Date()) {
  return new Date(value).toLocaleString('ar-YE', {
    dateStyle: 'medium',
    timeStyle: 'short',
  });
}

function escapeHtml(value) {
  return String(value ?? '—')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function printVoucher(voucher) {
  const printWindow = window.open('', '_blank', 'width=760,height=900');
  if (!printWindow) return false;

  const rows = [
    ['نوع العملية', voucher.operation],
    ['رقم الحوالة', voucher.remittanceNumber],
    ['اسم الشبكة', voucher.networkName],
    ['المرسل', voucher.sender],
    ['المستلم', voucher.recipient],
    ['رقم الهاتف', voucher.phone],
    ['المبلغ', `${voucher.amount} ${voucher.currency}`],
    ['الحالة', voucher.status],
    ['تاريخ اليوم', voucher.date],
    ...(voucher.verificationUrl ? [['رابط التحقق', voucher.verificationUrl]] : []),
    ...(voucher.receiptSignature ? [['بصمة الإيصال الرقمية', voucher.receiptSignature]] : []),
    ...(voucher.note && voucher.note !== '—' ? [['الملاحظة', voucher.note]] : []),
  ];

  printWindow.document.open();
  printWindow.document.write(`<!doctype html>
    <html lang="ar" dir="rtl">
      <head>
        <meta charset="UTF-8">
        <title>${escapeHtml(voucher.title)}</title>
        <style>
          * { box-sizing: border-box; }
          body { margin: 0; padding: 28px; background: #f3f4f6; color: #111827; font-family: Arial, Tahoma, sans-serif; }
          .voucher { max-width: 680px; margin: 0 auto; padding: 28px; background: #fff; border: 1px solid #d1d5db; border-radius: 18px; }
          .voucher-head { position: relative; overflow: hidden; min-height: 90px; }
          .success-mark { position: absolute; top: -52px; left: -34px; width: 190px; height: 190px; border-radius: 50%; background: radial-gradient(circle, rgba(34,197,94,.28), rgba(34,197,94,0) 68%); color: rgba(22,163,74,.18); font-size: 170px; line-height: 190px; text-align: center; transform: rotate(-12deg); }
          .voucher-head-content { position: relative; z-index: 1; }
          .brand { color: #dc2626; font-size: 13px; font-weight: 700; letter-spacing: .04em; }
          h1 { margin: 8px 0 4px; font-size: 26px; }
          .subtitle { margin: 0 0 22px; color: #6b7280; font-size: 13px; }
          .status { display: inline-block; padding: 7px 12px; border-radius: 999px; background: #dcfce7; color: #166534; font-size: 12px; font-weight: 700; }
          .amount { margin: 22px 0; padding: 18px; border-radius: 14px; background: #fff1f2; text-align: center; }
          .amount-label { color: #9f1239; font-size: 12px; }
          .amount-value { margin-top: 6px; color: #be123c; font-size: 28px; font-weight: 700; }
          table { width: 100%; border-collapse: collapse; }
          td { padding: 11px 0; border-bottom: 1px solid #e5e7eb; font-size: 13px; vertical-align: top; }
          td:first-child { width: 38%; color: #6b7280; }
          td:last-child { font-weight: 700; word-break: break-word; }
          .footer { margin-top: 24px; color: #6b7280; font-size: 11px; text-align: center; }
          @media print {
            body { padding: 0; background: #fff; }
            .voucher { max-width: none; border: 0; border-radius: 0; }
          }
        </style>
      </head>
      <body>
        <main class="voucher">
          <header class="voucher-head">
            <div class="success-mark" aria-hidden="true">✓</div>
            <div class="voucher-head-content">
              <div class="brand">محفظتي المالية</div>
              <h1>${escapeHtml(voucher.title)}</h1>
              <p class="subtitle">سند إلكتروني صادر من نظام المحفظة</p>
            </div>
          </header>
          <span class="status">${escapeHtml(voucher.status)}</span>
          <section class="amount">
            <div class="amount-label">المبلغ</div>
            <div class="amount-value">${escapeHtml(voucher.amount)} ${escapeHtml(voucher.currency)}</div>
          </section>
          ${voucher.qrDataUrl ? `<div style="text-align:center;margin:18px 0"><img src="${escapeHtml(voucher.qrDataUrl)}" alt="QR للتحقق" width="120" height="120"><div style="font-size:11px;color:#6b7280">امسح للتحقق من صحة الإيصال</div></div>` : ''}
          <table>${rows.map(([label, value]) => `<tr><td>${escapeHtml(label)}</td><td>${escapeHtml(value)}</td></tr>`).join('')}</table>
          <div class="footer">يرجى الاحتفاظ بهذا السند كمرجع للعملية.</div>
        </main>
        <script>
          window.addEventListener('load', function () {
            window.focus();
            window.print();
          });
          window.addEventListener('afterprint', function () {
            window.setTimeout(function () { window.close(); }, 200);
          });
        </script>
      </body>
    </html>`);
  printWindow.document.close();
  return true;
}

async function downloadVoucherImage(voucher) {
  const canvas = document.createElement('canvas');
  canvas.width = 1100;
  canvas.height = 1450;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('تعذر إنشاء صورة الإيصال');

  context.fillStyle = '#f8fafc';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.fillStyle = '#ffffff';
  context.fillRect(48, 48, canvas.width - 96, canvas.height - 96);
  context.strokeStyle = '#e2e8f0';
  context.lineWidth = 2;
  context.strokeRect(48, 48, canvas.width - 96, canvas.height - 96);
  context.direction = 'rtl';
  context.textAlign = 'right';
  context.fillStyle = '#be123c';
  context.font = 'bold 30px Arial, Tahoma, sans-serif';
  context.fillText('محفظتي المالية', 990, 120);
  context.fillStyle = '#111827';
  context.font = 'bold 42px Arial, Tahoma, sans-serif';
  context.fillText(voucher.title || 'إيصال عملية', 990, 190);
  context.fillStyle = '#be123c';
  context.textAlign = 'center';
  context.font = 'bold 48px Arial, Tahoma, sans-serif';
  context.fillText(`${voucher.amount} ${voucher.currency}`, 550, 300);
  context.textAlign = 'right';
  context.font = '26px Arial, Tahoma, sans-serif';

  const rows = [
    ['رقم الإيصال', voucher.remittanceNumber],
    ['العملية', voucher.operation],
    ['المرسل', voucher.sender],
    ['المستلم', voucher.recipient],
    ['رقم الهاتف', voucher.phone],
    ['الحالة', voucher.status],
    ['التاريخ', voucher.date],
  ];
  let y = 400;
  for (const [label, value] of rows) {
    context.fillStyle = '#6b7280';
    context.fillText(label, 990, y);
    context.fillStyle = '#111827';
    context.textAlign = 'left';
    context.fillText(String(value || '—').slice(0, 52), 110, y);
    context.textAlign = 'right';
    y += 82;
  }
  if (voucher.qrDataUrl) {
    const image = new Image();
    image.src = voucher.qrDataUrl;
    await new Promise((resolve) => {
      image.onload = resolve;
      image.onerror = resolve;
    });
    if (image.complete && image.naturalWidth) {
      context.drawImage(image, 460, 1030, 180, 180);
      context.fillStyle = '#6b7280';
      context.textAlign = 'center';
      context.font = '20px Arial, Tahoma, sans-serif';
      context.fillText('امسح للتحقق من صحة الإيصال', 550, 1240);
    }
  }
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('تعذر حفظ صورة الإيصال');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `wallet-receipt-${voucher.remittanceNumber || Date.now()}.png`;
  link.click();
  URL.revokeObjectURL(url);
}

export default function TransfersView({ currentUser, onBack, initialView = 'main' }) {
  const [activeView, setActiveView] = useState(initialView);
  const [selectedNetwork, setSelectedNetwork] = useState(null);
  const [message, setMessage] = useState(EMPTY_MESSAGE);
  const [loading, setLoading] = useState(false);
  const [voucherData, setVoucherData] = useState(null);
  const [remittanceNo, setRemittanceNo] = useState('');
  const [remittanceResult, setRemittanceResult] = useState(null);
  const [fromCurrency, setFromCurrency] = useState('USD');
  const [toCurrency, setToCurrency] = useState('YER');
  const [exchangeAmount, setExchangeAmount] = useState('');
  const [exchangePin, setExchangePin] = useState('');
  const [transfer, setTransfer] = useState({ receiverAccountId: '', amount: '', currency: 'YER', pin: '', otp: '' });
  const [receiver, setReceiver] = useState(null);
  const [scanning, setScanning] = useState(false);
  const [localForm, setLocalForm] = useState({ receiverName: '', receiverPhone: '', amount: '', note: '' });
  const [externalForm, setExternalForm] = useState({ provider: '', account: '', amount: '', currency: 'YER' });

  const videoRef = useRef(null);
  const convertedAmount = useMemo(() => '—', []);
  const userId = currentUser?.user?.id || currentUser?.id || 1;

  useEffect(() => {
    if (!scanning) return undefined;
    let active = true;
    let stream;
    let timer;

    const startScanner = async () => {
      try {
        if (!('BarcodeDetector' in window) || !navigator.mediaDevices?.getUserMedia) {
          setMessage({ type: 'error', text: 'المتصفح لا يدعم مسح QR بالكاميرا؛ أدخل رقم الحساب يدويًا.' });
          setScanning(false);
          return;
        }
        const detector = new window.BarcodeDetector({ formats: ['qr_code'] });
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' } },
          audio: false,
        });
        if (!active || !videoRef.current) {
          stream.getTracks().forEach((track) => track.stop());
          return;
        }
        videoRef.current.srcObject = stream;
        await videoRef.current.play();

        const scanFrame = async () => {
          if (!active || !videoRef.current) return;
          try {
            const codes = await detector.detect(videoRef.current);
            const value = codes[0]?.rawValue || '';
            let account = value.match(/^WALLET:(7\d{8})$/i)?.[1] || '';
            if (!account) {
              try {
                account = new URL(value).searchParams.get('to')?.match(/^7\d{8}$/)?.[0] || '';
              } catch {
                account = '';
              }
            }
            if (account) {
              setTransfer((previous) => ({ ...previous, receiverAccountId: account }));
              setReceiver(null);
              setMessage({ type: 'success', text: 'تمت قراءة رقم الحساب؛ تحقق من المستلم قبل التحويل.' });
              setScanning(false);
              return;
            }
          } catch {
            // Continue scanning the next camera frame.
          }
          timer = window.setTimeout(scanFrame, 350);
        };
        scanFrame();
      } catch {
        setMessage({ type: 'error', text: 'تعذر فتح الكاميرا. تحقق من الإذن أو أدخل رقم الحساب يدويًا.' });
        setScanning(false);
      }
    };

    startScanner();
    return () => {
      active = false;
      window.clearTimeout(timer);
      stream?.getTracks().forEach((track) => track.stop());
    };
  }, [scanning]);

  const go = (view) => {
    setMessage(EMPTY_MESSAGE);
    setReceiver(null);
    setRemittanceResult(null);
    setActiveView(view);
  };

  const handleBack = () => {
    if (activeView === 'main') {
      onBack?.();
    } else if (['send_remittance', 'receive_remittance', 'remittance_status', 'remittance_cancel'].includes(activeView)) {
      go('local_networks');
    } else {
      go('main');
    }
  };

  const handleSubscriberLookup = async (event) => {
    event.preventDefault();
    if (!PUBLIC_ACCOUNT_PATTERN.test(String(transfer.receiverAccountId).trim())) {
      setMessage({ type: 'error', text: 'رقم الحساب يجب أن يتكون من 9 أرقام ويبدأ بالرقم 7' });
      return;
    }
    setLoading(true);
    setMessage(EMPTY_MESSAGE);
    try {
      const data = await request(`/api/account-info/${encodeURIComponent(transfer.receiverAccountId)}`);
      setReceiver(data.receiver);
      setMessage({ type: 'success', text: 'تم العثور على حساب المستلم. راجع البيانات ثم أكد الحوالة.' });
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setLoading(false);
    }
  };

  const handleSubscriberTransfer = async () => {
    setLoading(true);
    setMessage(EMPTY_MESSAGE);
    try {
      const data = await request('/api/transfers/send', {
        method: 'POST',
        body: JSON.stringify({ ...transfer, userId }),
      });
      if (data.transaction?.transactionId && typeof window !== 'undefined') {
        window.sendTransferNotification?.({
          transactionId: data.transaction.transactionId,
        });
      }
      setMessage({ type: 'success', text: data.message || 'تمت الحوالة بنجاح' });
      const receiptId = data.transaction?.transactionId;
      const receiptSignatureValue = data.transaction?.receiptSignature;
      const verificationUrl = receiptId && receiptSignatureValue
        ? `${window.location.origin}/api/receipts/${receiptId}/verify?signature=${encodeURIComponent(receiptSignatureValue)}`
        : '';
      let qrDataUrl = '';
      if (verificationUrl) {
        try {
          const qr = await request(`/api/qr-code?payload=${encodeURIComponent(verificationUrl)}`);
          qrDataUrl = qr.dataUrl || '';
        } catch {
          // The signed receipt remains usable if QR rendering is unavailable.
        }
      }
      setVoucherData({
        title: 'سند حوالة مالية',
        operation: 'تحويل إلى مشترك',
        remittanceNumber: receiptId ? `TR-${receiptId}` : `TR-${String(Date.now()).slice(-8)}`,
        networkName: 'تحويل داخلي',
        sender: 'حسابي',
        recipient: receiver?.name || `الحساب رقم ${transfer.receiverAccountId}`,
        phone: '—',
        amount: transfer.amount,
        currency: transfer.currency,
        status: 'تمت العملية بنجاح',
        date: formatVoucherDate(),
        note: data.message || 'تم تنفيذ التحويل بنجاح',
        receiptSignature: receiptSignatureValue || '',
        verificationUrl,
        qrDataUrl,
      });
      setTransfer({ receiverAccountId: '', amount: '', currency: 'YER', pin: '', otp: '' });
      setReceiver(null);
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setLoading(false);
    }
  };

  const handleExchange = async (event) => {
    event.preventDefault();
    setMessage({ type: 'error', text: 'الصرف متوقف حتى ربط مزود أسعار محلي موثوق لصنعاء وعدن.' });
  };

  const handleSearchRemittance = async (event) => {
    event.preventDefault();
    if (!remittanceNo.trim()) {
      setMessage({ type: 'error', text: 'يرجى إدخال رقم الحوالة' });
      return;
    }
    setLoading(true);
    setMessage(EMPTY_MESSAGE);
    try {
      const data = await request(`/api/local-remittance/${encodeURIComponent(remittanceNo.trim())}`);
      setRemittanceResult(data.remittance);
      setMessage({ type: 'success', text: 'تم العثور على بيانات الحوالة' });
      if (activeView === 'receive_remittance') {
        const remittance = data.remittance || {};
        setVoucherData({
          title: 'سند استلام حوالة',
          operation: 'استلام حوالة عبر شبكة محلية',
          remittanceNumber: firstValue(remittance, ['remittance_number', 'reference', 'id'], remittanceNo.trim()),
          networkName: firstValue(remittance, ['network_name', 'network', 'provider'], selectedNetwork?.name || 'شبكة محلية'),
          sender: firstValue(remittance, ['sender_name', 'sender_full_name', 'from_name']),
          recipient: firstValue(remittance, ['recipient_name', 'receiver_name', 'beneficiary_name']),
          phone: firstValue(remittance, ['recipient_phone', 'receiver_phone', 'beneficiary_phone']),
          amount: firstValue(remittance, ['amount'], '0.00'),
          currency: firstValue(remittance, ['currency'], ''),
          status: firstValue(remittance, ['status'], 'تم التحقق من الحوالة'),
          date: formatVoucherDate(),
          note: firstValue(remittance, ['note', 'notes', 'description']),
        });
      }
    } catch (error) {
      setMessage({ type: 'error', text: error.message });
    } finally {
      setLoading(false);
    }
  };

  const handleLocalSubmit = (event) => {
    event.preventDefault();
    const reference = `LR-${String(Date.now()).slice(-8)}`;
    const senderInfo = currentUser?.user || currentUser;
    setMessage({
      type: 'success',
      text: `تم تجهيز طلب الحوالة إلى ${localForm.receiverName || 'المستلم'}. سيتم إكمال الإرسال بعد اعتماد الشبكة.`,
    });
    setVoucherData({
      title: 'سند إرسال حوالة',
      operation: 'إرسال حوالة عبر شبكة محلية',
      remittanceNumber: reference,
      networkName: selectedNetwork?.name || 'شبكة محلية',
      sender: firstValue(senderInfo, ['full_name', 'name'], 'صاحب المحفظة'),
      recipient: localForm.receiverName,
      phone: localForm.receiverPhone,
      amount: localForm.amount,
      currency: 'YER',
      status: 'تم تسجيل طلب الإرسال',
      date: formatVoucherDate(),
      note: localForm.note || '—',
    });
  };

  const handleExternalSubmit = (event) => {
    event.preventDefault();
    const reference = `EX-${String(Date.now()).slice(-8)}`;
    setMessage({
      type: 'success',
      text: `تم تجهيز حوالة ${externalForm.amount || '0'} ${externalForm.currency} عبر ${externalForm.provider || 'الخدمة المختارة'}.`,
    });
    setVoucherData({
      title: 'سند تحويل',
      operation: activeView === 'banks' ? 'تحويل إلى بنك أو محفظة' : 'تحويل عبر واصل',
      remittanceNumber: reference,
      networkName: externalForm.provider || 'الخدمة المختارة',
      sender: 'حسابي',
      recipient: externalForm.account,
      phone: externalForm.account,
      amount: externalForm.amount,
      currency: externalForm.currency,
      status: 'تم تسجيل العملية بنجاح',
      date: formatVoucherDate(),
      note: 'تم تجهيز طلب التحويل',
    });
  };

  const handleVoucherClose = () => {
    setVoucherData(null);
    setActiveView('main');
    setMessage(EMPTY_MESSAGE);
    setSelectedNetwork(null);
    setRemittanceNo('');
    setRemittanceResult(null);
    setFromCurrency('USD');
    setToCurrency('YER');
    setExchangeAmount('');
    setExchangePin('');
    setTransfer({ receiverAccountId: '', amount: '', currency: 'YER', pin: '', otp: '' });
    setReceiver(null);
    setLocalForm({ receiverName: '', receiverPhone: '', amount: '', note: '' });
    setExternalForm({ provider: '', account: '', amount: '', currency: 'YER' });
  };

  const handlePrintVoucher = () => {
    if (!voucherData) return;
    if (!printVoucher(voucherData)) {
      setMessage({ type: 'error', text: 'تعذر فتح نافذة الطباعة. اسمح بالنوافذ المنبثقة ثم حاول مرة أخرى.' });
    }
  };

  const title = {
    main: 'تحويلات مالية',
    local_networks: 'حوالات شبكات محلية',
    receive_remittance: 'استلام حوالة عبر شبكات محلية',
    exchange: 'تحويل بين حساباتي (مصارفة)',
    send_remittance: 'إرسال حوالة عبر شبكة محلية',
    remittance_status: 'حالة حوالة شبكة محلية',
    remittance_cancel: 'إلغاء حوالة شبكة محلية',
    subscriber: 'تحويل إلى مشترك',
    banks: 'تحويل إلى بنك أو محفظة',
    wasel: 'تحويل إلى محافظ أخرى - واصل',
  }[activeView];

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <button type="button" aria-label="رجوع" style={styles.backBtn} onClick={handleBack}>❯</button>
        <h2 style={styles.headerTitle}>{title}</h2>
        {activeView === 'local_networks' ? (
          <button type="button" style={styles.refreshBtn} onClick={() => setMessage({ type: 'success', text: 'تم تحديث الشبكات المتاحة' })}>
            تحديث
          </button>
        ) : <span style={styles.headerSpacer} />}
      </div>

      {message.text && (
        <div role="status" style={{ ...styles.alertBox, backgroundColor: message.type === 'error' ? '#7f1d1d' : '#14532d', borderColor: message.type === 'error' ? '#ef4444' : '#22c55e' }}>
          {message.text}
        </div>
      )}

      {activeView === 'main' && (
        <div style={styles.menuList}>
          <Action label="تحويل إلى مشترك" icon="👤" onClick={() => go('subscriber')} />
          <Action label="تحويل بين حساباتي (مصارفة)" icon="🔄" onClick={() => go('exchange')} />
          <Action label="حوالات شبكات محلية" icon="💸" onClick={() => go('local_networks')} />
          <Action label="طلب استلام حوالة" icon="📄" onClick={() => go('receive_remittance')} />
          <Action label="بنوك ومحافظ" icon="🏦" onClick={() => go('banks')} />
          <Action label="تحويل إلى محافظ أخرى - واصل" icon="💳" onClick={() => go('wasel')} />
        </div>
      )}

      {activeView === 'local_networks' && (
        <div style={styles.menuList}>
          <Action label="إرسال حوالة عبر شبكات محلية" icon="↗" onClick={() => go('send_remittance')} />
          <Action label="استلام حوالة عبر شبكات محلية" icon="↙" onClick={() => go('receive_remittance')} />
          <Action label="حالة حوالة شبكة محلية" icon="◷" onClick={() => go('remittance_status')} />
          <Action label="إلغاء حوالة شبكة محلية" icon="×" onClick={() => go('remittance_cancel')} />
        </div>
      )}

      {activeView === 'subscriber' && (
        <form style={styles.formContainer} onSubmit={receiver ? (event) => { event.preventDefault(); void handleSubscriberTransfer(); } : handleSubscriberLookup}>
          <p style={styles.formHint}>أدخل بيانات المستلم للتحقق منها قبل تنفيذ الحوالة.</p>
          <button type="button" style={styles.secondaryButton} onClick={() => setScanning((value) => !value)}>
            {scanning ? 'إيقاف مسح QR' : 'مسح حساب المستلم عبر QR'}
          </button>
          {scanning && <video ref={videoRef} playsInline muted style={styles.scannerVideo} aria-label="كاميرا مسح رمز QR" />}
          <Field label="رقم حساب المستلم">
            <input
              required
              type="text"
              inputMode="numeric"
              maxLength={9}
              pattern="7[0-9]{8}"
              placeholder="700000002"
              style={styles.input}
              value={transfer.receiverAccountId}
              onChange={(event) => setTransfer({ ...transfer, receiverAccountId: event.target.value.replace(/\D/g, '').slice(0, 9) })}
            />
          </Field>
          <Field label="المبلغ">
            <input required type="number" min="0.01" step="0.01" style={styles.input} value={transfer.amount} onChange={(event) => setTransfer({ ...transfer, amount: event.target.value })} />
          </Field>
          <Field label="العملة">
            <select style={styles.input} value={transfer.currency} onChange={(event) => setTransfer({ ...transfer, currency: event.target.value })}>
              <option value="YER">ريال يمني (YER)</option><option value="SAR">ريال سعودي (SAR)</option><option value="USD">دولار أمريكي (USD)</option>
            </select>
          </Field>
          <Field label="رمز PIN">
            <input required type="password" inputMode="numeric" maxLength="4" style={styles.input} value={transfer.pin} onChange={(event) => setTransfer({ ...transfer, pin: event.target.value })} />
          </Field>
          <Field label="رمز التحقق الثنائي (إن كان مفعّلًا)">
            <input
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              style={styles.input}
              value={transfer.otp}
              onChange={(event) => setTransfer({ ...transfer, otp: event.target.value.replace(/\D/g, '').slice(0, 6) })}
            />
          </Field>
          {receiver && <div style={styles.confirmBox}>المستلم: <strong>{receiver.name}</strong></div>}
          <button type="submit" style={styles.redButton} disabled={loading}>{loading ? 'جاري المعالجة...' : receiver ? 'تأكيد الحوالة' : 'التحقق من المستلم'}</button>
        </form>
      )}

      {activeView === 'exchange' && (
        <form style={styles.formContainer} onSubmit={handleExchange}>
          <p style={styles.formHint}>حوّل الرصيد بين عملاتك مع عرض قيمة التحويل قبل التأكيد.</p>
          <Field label="من عملة">
            <select style={styles.input} value={fromCurrency} onChange={(event) => setFromCurrency(event.target.value)}>
              <option value="USD">دولار أمريكي (USD)</option><option value="SAR">ريال سعودي (SAR)</option><option value="YER">ريال يمني (YER)</option>
            </select>
          </Field>
          <Field label="إلى عملة">
            <select style={styles.input} value={toCurrency} onChange={(event) => setToCurrency(event.target.value)}>
              <option value="YER">ريال يمني (YER)</option><option value="SAR">ريال سعودي (SAR)</option><option value="USD">دولار أمريكي (USD)</option>
            </select>
          </Field>
          <Field label="المبلغ المراد تحويله">
            <input required type="number" min="0.01" step="0.01" style={styles.input} value={exchangeAmount} onChange={(event) => setExchangeAmount(event.target.value)} />
          </Field>
          <Field label="رمز PIN">
            <input required type="password" inputMode="numeric" maxLength="4" style={styles.input} value={exchangePin} onChange={(event) => setExchangePin(event.target.value)} />
          </Field>
          {exchangeAmount && <div style={styles.calcBox}>{convertedAmount} {toCurrency} — سعر الصرف: 1 {fromCurrency} = {exchangeRate} {toCurrency}</div>}
          <button type="submit" style={styles.redButton} disabled={loading}>{loading ? 'جاري تنفيذ المصارفة...' : 'تأكيد المصارفة'}</button>
        </form>
      )}

      {['receive_remittance', 'remittance_status', 'remittance_cancel'].includes(activeView) && (
        <div style={styles.formContainer}>
          <p style={styles.formHint}>يمكنك الاستعلام عن الحوالة مباشرة باستخدام الرقم المرجعي.</p>
          <form onSubmit={handleSearchRemittance}>
            <Field label="رقم الحوالة">
              <input required style={styles.input} value={remittanceNo} onChange={(event) => setRemittanceNo(event.target.value)} />
            </Field>
            <button type="submit" style={styles.redButton} disabled={loading}>{loading ? 'جاري البحث...' : 'بحث عن الحوالة'}</button>
          </form>
          {remittanceResult && <div style={styles.resultBox}><strong>{remittanceResult.network_name || selectedNetwork?.name || 'شبكة محلية'}</strong><span>الحالة: {remittanceResult.status || 'قيد المراجعة'}</span><span>المبلغ: {remittanceResult.amount || '--'} {remittanceResult.currency || ''}</span></div>}
          {activeView === 'receive_remittance' && <div style={styles.networkGrid}>{LOCAL_NETWORKS.map((network) => <button type="button" key={network.id} style={{ ...styles.networkCard, border: selectedNetwork?.id === network.id ? '2px solid #ef4444' : '1px solid #374151' }} onClick={() => setSelectedNetwork(network)}><span style={{ ...styles.networkBadge, backgroundColor: network.bg, color: network.color }}>{network.name.substring(0, 8)}</span><span style={styles.networkName}>{network.name}</span></button>)}</div>}
        </div>
      )}

      {activeView === 'send_remittance' && (
        <form style={styles.formContainer} onSubmit={handleLocalSubmit}>
          <p style={styles.formHint}>اختر الشبكة وأدخل بيانات المستلم لبدء طلب الحوالة.</p>
          <Field label="الشبكة">
            <select required style={styles.input} value={selectedNetwork?.id || ''} onChange={(event) => setSelectedNetwork(LOCAL_NETWORKS.find((network) => network.id === event.target.value) || null)}>
              <option value="">اختر شبكة محلية</option>{LOCAL_NETWORKS.map((network) => <option key={network.id} value={network.id}>{network.name}</option>)}
            </select>
          </Field>
          <Field label="اسم المستلم الرباعي"><input required style={styles.input} value={localForm.receiverName} onChange={(event) => setLocalForm({ ...localForm, receiverName: event.target.value })} /></Field>
          <Field label="رقم هاتف المستلم"><input required type="tel" style={styles.input} value={localForm.receiverPhone} onChange={(event) => setLocalForm({ ...localForm, receiverPhone: event.target.value })} /></Field>
          <Field label="المبلغ"><input required type="number" min="0.01" step="0.01" style={styles.input} value={localForm.amount} onChange={(event) => setLocalForm({ ...localForm, amount: event.target.value })} /></Field>
          <Field label="ملاحظة (اختياري)"><textarea style={{ ...styles.input, minHeight: '76px', resize: 'vertical' }} value={localForm.note} onChange={(event) => setLocalForm({ ...localForm, note: event.target.value })} /></Field>
          <button type="submit" style={styles.redButton}>متابعة إرسال الحوالة</button>
        </form>
      )}

      {['banks', 'wasel'].includes(activeView) && (
        <form style={styles.formContainer} onSubmit={handleExternalSubmit}>
          <p style={styles.formHint}>أدخل بيانات الجهة والمبلغ لفتح طلب التحويل.</p>
          <Field label={activeView === 'banks' ? 'اسم البنك أو المحفظة' : 'اسم المحفظة المستلمة'}><input required style={styles.input} value={externalForm.provider} onChange={(event) => setExternalForm({ ...externalForm, provider: event.target.value })} /></Field>
          <Field label="رقم الحساب أو الهاتف"><input required style={styles.input} value={externalForm.account} onChange={(event) => setExternalForm({ ...externalForm, account: event.target.value })} /></Field>
          <Field label="المبلغ"><input required type="number" min="0.01" step="0.01" style={styles.input} value={externalForm.amount} onChange={(event) => setExternalForm({ ...externalForm, amount: event.target.value })} /></Field>
          <Field label="العملة"><select style={styles.input} value={externalForm.currency} onChange={(event) => setExternalForm({ ...externalForm, currency: event.target.value })}><option value="YER">YER</option><option value="SAR">SAR</option><option value="USD">USD</option></select></Field>
          <button type="submit" style={styles.redButton}>متابعة التحويل</button>
        </form>
      )}

      {voucherData && (
        <VoucherModal
          voucherData={voucherData}
          onClose={handleVoucherClose}
          onPrint={handlePrintVoucher}
        />
      )}
    </div>
  );
}

function VoucherModal({ voucherData, onClose, onPrint }) {
  const rows = [
    ['رقم الحوالة', voucherData.remittanceNumber],
    ['اسم الشبكة', voucherData.networkName],
    ['المرسل', voucherData.sender],
    ['المستلم', voucherData.recipient],
    ['رقم الهاتف', voucherData.phone],
    ['الحالة', voucherData.status],
    ['تاريخ اليوم', voucherData.date],
    ...(voucherData.note && voucherData.note !== '—' ? [['الملاحظة', voucherData.note]] : []),
  ];

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="voucher-title" style={styles.modalOverlay}>
      <div style={styles.voucherModal}>
        <div style={styles.voucherHeader}>
          <div style={styles.successMark} aria-hidden="true">✓</div>
          <div style={styles.voucherHeaderContent}>
            <span style={styles.voucherEyebrow}>محفظتي المالية</span>
            <h3 id="voucher-title" style={styles.voucherTitle}>{voucherData.title}</h3>
            <p style={styles.voucherSubtitle}>سند إلكتروني صادر من نظام المحفظة</p>
          </div>
          <button type="button" aria-label="إغلاق السند" style={styles.closeBtn} onClick={onClose}>×</button>
        </div>
        <div style={styles.voucherStatus}>{voucherData.status}</div>
        <div style={styles.voucherAmount}>
          <span>المبلغ</span>
          <strong style={styles.voucherAmountValue}>{voucherData.amount} {voucherData.currency}</strong>
        </div>
        <div style={styles.voucherRows}>
          {rows.map(([label, value]) => (
            <div key={label} style={styles.voucherRow}>
              <span style={styles.voucherRowLabel}>{label}</span>
              <strong style={styles.voucherRowValue}>{value}</strong>
            </div>
          ))}
        </div>
        <p style={styles.voucherFooter}>يرجى الاحتفاظ بهذا السند كمرجع للعملية.</p>
        <div style={styles.voucherActions}>
          <button type="button" style={styles.printButton} onClick={onPrint}>طباعة / حفظ PDF</button>
          <button type="button" style={styles.secondaryButton} onClick={onClose}>إغلاق</button>
        </div>
      </div>
    </div>
  );
}

function Action({ label, icon, onClick }) {
  return <button type="button" style={styles.menuCard} onClick={onClick}><span style={styles.cardText}>{label}</span><span style={styles.cardIcon}>{icon}</span></button>;
}

function Field({ label, children }) {
  return <label style={styles.field}><span style={styles.label}>{label}</span>{children}</label>;
}

const styles = {
  container: {
    backgroundColor: '#121318',
    color: '#ffffff',
    minHeight: '100vh',
    padding: '16px',
    fontFamily: 'system-ui, -apple-system, sans-serif',
    direction: 'rtl'
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '20px',
    borderBottom: '1px solid #272a37',
    paddingBottom: '12px'
  },
  headerTitle: {
    fontSize: '18px',
    fontWeight: 'bold',
    margin: 0
  },
  headerSpacer: {
    width: '56px'
  },
  backBtn: {
    background: 'none',
    border: 'none',
    color: '#ffffff',
    fontSize: '20px',
    cursor: 'pointer',
    padding: '8px'
  },
  refreshBtn: {
    backgroundColor: '#272a37',
    color: '#ffffff',
    border: 'none',
    borderRadius: '8px',
    padding: '6px 12px',
    fontSize: '12px',
    cursor: 'pointer'
  },
  menuList: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px'
  },
  menuCard: {
    backgroundColor: '#1d1e26',
    borderRadius: '12px',
    padding: '16px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    cursor: 'pointer',
    border: '1px solid #2a2c38'
  },
  cardIcon: {
    width: '36px',
    height: '36px',
    borderRadius: '8px',
    backgroundColor: '#2a2c3a',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '18px'
  },
  cardText: {
    fontSize: '15px',
    fontWeight: '500'
  },
  formContainer: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px'
  },
  field: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px'
  },
  formHint: {
    color: '#9ca3af',
    fontSize: '13px',
    lineHeight: '1.6',
    margin: 0,
    textAlign: 'center'
  },
  confirmBox: {
    backgroundColor: '#132e22',
    border: '1px solid #22c55e',
    borderRadius: '10px',
    color: '#bbf7d0',
    fontSize: '13px',
    padding: '12px',
    textAlign: 'center'
  },
  resultBox: {
    backgroundColor: '#1d1e26',
    border: '1px solid #374151',
    borderRadius: '10px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
    padding: '14px',
    color: '#d1d5db',
    fontSize: '13px'
  },
  centerIcon: {
    width: '64px',
    height: '64px',
    borderRadius: '16px',
    backgroundColor: '#1d1e26',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: '32px',
    margin: '0 auto 8px auto'
  },
  warningText: {
    color: '#ef4444',
    fontSize: '13px',
    textAlign: 'center',
    lineHeight: '1.5',
    fontWeight: 'bold'
  },
  input: {
    width: '100%',
    padding: '14px',
    backgroundColor: '#1d1e26',
    border: '1px solid #374151',
    borderRadius: '10px',
    color: '#ffffff',
    fontSize: '14px',
    marginBottom: '12px',
    boxSizing: 'border-box'
  },
  label: {
    fontSize: '13px',
    color: '#9ca3af',
    marginBottom: '4px',
    display: 'block'
  },
  redButton: {
    width: '100%',
    padding: '14px',
    backgroundColor: '#e52330',
    color: '#ffffff',
    border: 'none',
    borderRadius: '10px',
    fontSize: '16px',
    fontWeight: 'bold',
    cursor: 'pointer',
    marginTop: '8px'
  },
  subTitle: {
    fontSize: '14px',
    color: '#d1d5db',
    textAlign: 'center',
    marginTop: '16px',
    marginBottom: '12px'
  },
  networkGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: '10px'
  },
  networkCard: {
    backgroundColor: '#ffffff',
    borderRadius: '10px',
    padding: '10px 6px',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
    minHeight: '70px',
    textAlign: 'center'
  },
  networkBadge: {
    padding: '4px 6px',
    borderRadius: '6px',
    fontSize: '10px',
    fontWeight: 'bold',
    marginBottom: '4px'
  },
  networkName: {
    color: '#111827',
    fontSize: '11px',
    fontWeight: 'bold'
  },
  alertBox: {
    padding: '12px',
    borderRadius: '8px',
    marginBottom: '16px',
    fontSize: '13px',
    border: '1px solid',
    textAlign: 'center'
  },
  calcBox: {
    backgroundColor: '#1f2937',
    padding: '10px',
    borderRadius: '8px',
    color: '#10b981',
    fontSize: '13px',
    textAlign: 'center',
    marginBottom: '12px'
  },
  modalOverlay: {
    position: 'fixed',
    inset: 0,
    zIndex: 9999,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '16px',
    backgroundColor: 'rgba(0, 0, 0, 0.78)'
  },
  voucherModal: {
    width: '100%',
    maxWidth: '460px',
    maxHeight: 'calc(100vh - 32px)',
    overflowY: 'auto',
    backgroundColor: '#ffffff',
    color: '#111827',
    borderRadius: '20px',
    padding: '22px',
    boxShadow: '0 24px 80px rgba(0, 0, 0, 0.45)',
    direction: 'rtl'
  },
  voucherHeader: {
    display: 'flex',
    alignItems: 'flex-start',
    justifyContent: 'space-between',
    gap: '12px',
    position: 'relative',
    overflow: 'hidden',
    minHeight: '90px',
    borderBottom: '1px solid #e5e7eb',
    paddingBottom: '14px'
  },
  voucherHeaderContent: {
    position: 'relative',
    zIndex: 1
  },
  successMark: {
    position: 'absolute',
    top: '-52px',
    left: '-34px',
    width: '190px',
    height: '190px',
    borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(34,197,94,.28), rgba(34,197,94,0) 68%)',
    color: 'rgba(22,163,74,.18)',
    fontSize: '170px',
    lineHeight: '190px',
    textAlign: 'center',
    transform: 'rotate(-12deg)'
  },
  voucherEyebrow: {
    color: '#dc2626',
    fontSize: '11px',
    fontWeight: '700'
  },
  voucherTitle: {
    margin: '6px 0 4px',
    fontSize: '21px',
    fontWeight: '800'
  },
  voucherSubtitle: {
    margin: 0,
    color: '#6b7280',
    fontSize: '11px'
  },
  closeBtn: {
    width: '32px',
    height: '32px',
    border: 'none',
    borderRadius: '9px',
    backgroundColor: '#f3f4f6',
    color: '#4b5563',
    fontSize: '22px',
    lineHeight: 1,
    cursor: 'pointer'
  },
  voucherStatus: {
    display: 'inline-block',
    marginTop: '16px',
    padding: '7px 12px',
    borderRadius: '999px',
    backgroundColor: '#dcfce7',
    color: '#166534',
    fontSize: '11px',
    fontWeight: '700'
  },
  voucherAmount: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '5px',
    margin: '16px 0',
    padding: '16px',
    borderRadius: '14px',
    backgroundColor: '#fff1f2',
    color: '#9f1239',
    fontSize: '12px'
  },
  voucherAmountValue: {
    color: '#be123c',
    fontSize: '27px',
    fontWeight: '800'
  },
  voucherRows: {
    borderTop: '1px solid #e5e7eb'
  },
  voucherRow: {
    display: 'flex',
    justifyContent: 'space-between',
    gap: '16px',
    padding: '10px 0',
    borderBottom: '1px solid #e5e7eb',
    fontSize: '12px'
  },
  voucherRowLabel: {
    color: '#6b7280'
  },
  voucherRowValue: {
    maxWidth: '62%',
    color: '#111827',
    textAlign: 'left',
    wordBreak: 'break-word'
  },
  voucherFooter: {
    margin: '16px 0 0',
    color: '#6b7280',
    fontSize: '10px',
    textAlign: 'center'
  },
  voucherActions: {
    display: 'grid',
    gridTemplateColumns: '1.2fr 1fr',
    gap: '10px',
    marginTop: '18px'
  },
  printButton: {
    border: 'none',
    borderRadius: '10px',
    padding: '12px',
    backgroundColor: '#dc2626',
    color: '#ffffff',
    fontSize: '13px',
    fontWeight: '700',
    cursor: 'pointer'
  },
  secondaryButton: {
    border: '1px solid #d1d5db',
    borderRadius: '10px',
    padding: '12px',
    backgroundColor: '#f9fafb',
    color: '#374151',
    fontSize: '13px',
    fontWeight: '700',
    cursor: 'pointer'
  }
};
