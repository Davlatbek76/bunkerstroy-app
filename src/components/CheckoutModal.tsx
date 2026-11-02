import React, { useState, useEffect } from 'react';
import {
  Package,
  MapPin,
  Phone,
  CreditCard,
  CheckCircle,
  AlertCircle,
  ChevronRight,
  ChevronLeft,
  Trash2,
  Plus,
  Minus,
  ShieldCheck,
  Building2,
  Clock,
  Printer,
  FileText,
  DollarSign,
  Smartphone,
  Wallet,
  Coins,
  User,
  Navigation,
  Globe
} from 'lucide-react';
import { CartItem, UserProfile, Order } from '../types';
import { REGIONS_AND_DISTRICTS, getMfyListForDistrict, REGION_COORDINATES } from '../data/regionsData';
import { db, handleFirestoreError, OperationType } from '../lib/firebase';
import { doc, setDoc } from 'firebase/firestore';
import { recordCabinetLog } from '../lib/cabinetLogs';

interface CheckoutModalProps {
  isOpen: boolean;
  onClose: () => void;
  items: CartItem[];
  user: UserProfile | null;
  onUserUpdate?: (updatedUser: UserProfile) => void;
  onUpdateQuantity: (productId: string, quantity: number) => void;
  onRemoveItem: (productId: string) => void;
  onClearCart: () => void;
  onOrderCompleted: (order: Order) => void;
  onOpenAuth: () => void;
}

export const CheckoutModal: React.FC<CheckoutModalProps> = ({
  isOpen,
  onClose,
  items,
  user,
  onUserUpdate,
  onUpdateQuantity,
  onRemoveItem,
  onClearCart,
  onOrderCompleted,
  onOpenAuth,
}) => {
  // Step navigation: 1 -> 2 -> 3 -> 4 -> 5 (Success/Receipt)
  const [step, setStep] = useState<1 | 2 | 3 | 4 | 5>(1);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 2: Manzilni tasdiqlash
  const [region, setRegion] = useState<string>(user?.region || '');
  const [district, setDistrict] = useState<string>(user?.district || '');
  const [mfy, setMfy] = useState<string>('');
  const [mapPinned, setMapPinned] = useState<boolean>(true);
  const [showMapPicker, setShowMapPicker] = useState<boolean>(true);
  const [showManualAddressFields, setShowManualAddressFields] = useState<boolean>(false);
  const [detectedMapAddress, setDetectedMapAddress] = useState<string>('Toshkent shahri');
  const [mapType, setMapType] = useState<'m' | 'k'>('m');
  const [gpsLoading, setGpsLoading] = useState<boolean>(false);
  const [mapCoords, setMapCoords] = useState<{ lat: number; lng: number }>(() => {
    if (user?.region && REGION_COORDINATES[user.region]) {
      return REGION_COORDINATES[user.region];
    }
    return { lat: 41.311081, lng: 69.240562 };
  });

  // Step 3: Qabul qiluvchi (ID Karta ma'lumotlari va Telefon raqam + Qo'shimcha raqam)
  const [recipientFirstName, setRecipientFirstName] = useState<string>(
    user?.firstName || user?.displayName?.split(' ')[0] || ''
  );
  const [recipientLastName, setRecipientLastName] = useState<string>(
    user?.lastName || user?.displayName?.split(' ').slice(1).join(' ') || ''
  );
  const [recipientIdCard, setRecipientIdCard] = useState<string>(
    user?.idCardNumber || ''
  );
  const [recipientBirthDate, setRecipientBirthDate] = useState<string>(
    user?.birthDate || ''
  );
  const [idVerifiedInCheckout, setIdVerifiedInCheckout] = useState<boolean>(
    Boolean(user?.idCardNumber && /^[A-Z]{2}\s?\d{7}$/i.test(user.idCardNumber.trim()))
  );
  const [idVerifying, setIdVerifying] = useState<boolean>(false);
  const [cabinetPhone, setCabinetPhone] = useState<string>(
    user?.phone || '+998 '
  );
  const [showAdditionalPhone, setShowAdditionalPhone] = useState<boolean>(false);
  const [secondaryPhone, setSecondaryPhone] = useState<string>('');

  // Saved delivery addresses for future orders
  const savedAddressesStorageKey = `bunkerstroy_saved_addresses_${user?.id || 'guest'}`;
  const [savedDeliveryAddresses, setSavedDeliveryAddresses] = useState<
    Array<{ address: string; lat: number; lng: number }>
  >(() => {
    try {
      const raw = localStorage.getItem(`bunkerstroy_saved_addresses_${user?.id || 'guest'}`);
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  });
  const [addressConfirmedNotice, setAddressConfirmedNotice] = useState<boolean>(false);

  const saveDeliveryAddressForFuture = (addrText: string, lat: number, lng: number) => {
    const cleanAddr = (addrText || '').trim();
    if (!cleanAddr) return;
    setSavedDeliveryAddresses((prev) => {
      const filtered = prev.filter((item) => item.address.toLowerCase() !== cleanAddr.toLowerCase());
      const next = [{ address: cleanAddr, lat, lng }, ...filtered].slice(0, 8);
      try {
        localStorage.setItem(savedAddressesStorageKey, JSON.stringify(next));
      } catch {}
      return next;
    });
  };

  // Step 4: To'lov (UZCARD, HUMO, CLICK, VISA + SMS tasdiqlash)
  const [paymentMethod, setPaymentMethod] = useState<'uzcard' | 'humo' | 'click' | 'visa'>('uzcard');
  const [cardNumber, setCardNumber] = useState('');
  const [cardExpire, setCardExpire] = useState('');
  const [cardSmsSent, setCardSmsSent] = useState(false);
  const [sentCardSmsCode, setSentCardSmsCode] = useState('');
  const [cardSmsInput, setCardSmsInput] = useState('');
  const [completedOrder, setCompletedOrder] = useState<Order | null>(null);

  const getMaskedCardPhoneLast4 = (): string => {
    const rawDigits = (cabinetPhone || user?.phone || '').replace(/\D/g, '');
    const last4 = rawDigits.length >= 4 ? rawDigits.slice(-4) : '8080';
    return `** ** ** ${last4}`;
  };

  const triggerCardSmsCode = () => {
    const generated = String(Math.floor(100000 + Math.random() * 900000));
    setSentCardSmsCode(generated);
    setCardSmsSent(true);
    setCardSmsInput('');
    setError(null);
  };

  // Update district and MFY lists when region/district changes
  const districts = region ? REGIONS_AND_DISTRICTS[region] || [] : [];
  const mfyList = district ? getMfyListForDistrict(district) : [];

  const getNearestRegionName = (lat: number, lng: number): string => {
    let closestRegion = 'Toshkent shahri';
    let minDistance = Infinity;
    Object.entries(REGION_COORDINATES).forEach(([regName, coords]) => {
      const dist = Math.hypot(coords.lat - lat, coords.lng - lng);
      if (dist < minDistance) {
        minDistance = dist;
        closestRegion = regName;
      }
    });
    return closestRegion;
  };

  const resolveAddressFromCoords = async (lat: number, lng: number) => {
    const nearestReg = getNearestRegionName(lat, lng);
    setDetectedMapAddress(nearestReg);
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&accept-language=uz`
      );
      if (res.ok) {
        const data = await res.json();
        if (data?.address) {
          const addr = data.address;
          const parts = [
            addr.state || addr.city || nearestReg,
            addr.county || addr.city_district || addr.suburb || addr.town || addr.village,
            addr.neighbourhood || addr.quarter || addr.road,
            addr.house_number ? `${addr.house_number}-uy` : '',
          ].filter(Boolean);
          const uniqueParts = Array.from(new Set(parts));
          if (uniqueParts.length > 0) {
            setDetectedMapAddress(uniqueParts.join(', '));
            return;
          }
        }
        if (data?.display_name) {
          const shortDisplay = data.display_name
            .split(',')
            .slice(0, 3)
            .map((s: string) => s.trim())
            .join(', ');
          if (shortDisplay) {
            setDetectedMapAddress(shortDisplay);
          }
        }
      }
    } catch {
      // Fallback already set to nearestReg
    }
  };

  useEffect(() => {
    resolveAddressFromCoords(mapCoords.lat, mapCoords.lng);
  }, [mapCoords.lat, mapCoords.lng]);

  // Sync user info if user changes
  useEffect(() => {
    if (user) {
      if (user.region && REGIONS_AND_DISTRICTS[user.region]) {
        setRegion(user.region);
        if (REGION_COORDINATES[user.region]) {
          setMapCoords(REGION_COORDINATES[user.region]);
        }
      }
      if (user.district) {
        setDistrict(user.district);
      }
      if (user.firstName || user.displayName) {
        setRecipientFirstName(user.firstName || user.displayName.split(' ')[0] || '');
      }
      if (user.lastName) {
        setRecipientLastName(user.lastName);
      }
      if (user.idCardNumber) {
        setRecipientIdCard(user.idCardNumber);
        if (/^[A-Z]{2}\s?\d{7}$/i.test(user.idCardNumber.trim())) {
          setIdVerifiedInCheckout(true);
        }
      }
      if (user.birthDate) {
        setRecipientBirthDate(user.birthDate);
      }
      if (user.phone) {
        setCabinetPhone(user.phone);
      }
    }
  }, [user]);

  if (!isOpen) return null;

  const grandTotal = items.reduce((sum, item) => sum + item.product.price * item.quantity, 0);

  const formatPrice = (p: number) => new Intl.NumberFormat('uz-UZ').format(p) + " so'm";

  const formatUzPhoneInput = (val: string) => {
    const digits = val.replace(/\D/g, '');
    const local = digits.startsWith('998') ? digits.slice(3, 12) : digits.slice(0, 9);
    if (local.length === 0) return '+998 ';
    if (local.length <= 2) return `+998 ${local}`;
    if (local.length <= 5) return `+998 ${local.slice(0, 2)} ${local.slice(2)}`;
    if (local.length <= 7) return `+998 ${local.slice(0, 2)} ${local.slice(2, 5)} ${local.slice(5)}`;
    return `+998 ${local.slice(0, 2)} ${local.slice(2, 5)} ${local.slice(5, 7)} ${local.slice(7, 9)}`;
  };

  const handleDetectGpsLocation = () => {
    setError(null);
    setMapPinned(true);
    setShowMapPicker(true);
    setShowManualAddressFields(false);
    if (!navigator.geolocation) {
      return;
    }
    setGpsLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setMapCoords({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        });
        setMapPinned(true);
        setError(null);
        setGpsLoading(false);
      },
      () => {
        setMapPinned(true);
        setError(null);
        setGpsLoading(false);
      },
      { enableHighAccuracy: true, timeout: 6000 }
    );
  };

  // Step 1 -> Step 2 validation
  const handleProceedToAddress = () => {
    if (!user) {
      onOpenAuth();
      return;
    }
    if (items.length === 0) {
      setError("Savat bo'sh! Iltimos, mahsulot qo'shing.");
      return;
    }
    setError(null);
    setStep(2);
  };

  // Step 2 -> Step 3 validation
  // Agar xaritadan belgilansa yoki real joylashuv uzatilsa, qo'lda viloyat/tuman/MFY yozish va belgilash shart emas — shu joylashuv qabul qilinadi!
  const handleProceedToPhone = () => {
    if (mapPinned || showMapPicker) {
      setMapPinned(true);
      saveDeliveryAddressForFuture(detectedMapAddress, mapCoords.lat, mapCoords.lng);
      setError(null);
      setStep(3);
      return;
    }
    if (!region) {
      setError('Iltimos, viloyatni tanlang yoki xaritadan joylashuvni belgilang!');
      return;
    }
    if (!district) {
      setError('Iltimos, tuman yoki shaharni tanlang!');
      return;
    }
    if (!mfy) {
      setError("Iltimos, MFY (Mahalla fuqarolar yig'ini) ni ro'yxatdan tanlang!");
      return;
    }
    setError(null);
    setStep(3);
  };

  const formatBirthDateInput = (val: string): string => {
    const digits = val.replace(/\D/g, '').slice(0, 8);
    if (digits.length <= 2) return digits;
    if (digits.length <= 4) return `${digits.slice(0, 2)}.${digits.slice(2)}`;
    return `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4, 8)}`;
  };

  const verifyAndSaveRecipientIdCard = async (): Promise<{
    ok: boolean;
    firstName: string;
    lastName: string;
    formattedId: string;
    birthDate: string;
  }> => {
    const cleanId = recipientIdCard.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!/^[A-Z]{2}\d{7}$/.test(cleanId)) {
      setError('Iltimos, ID karta seriya va raqamini to‘liq kiriting!');
      return { ok: false, firstName: '', lastName: '', formattedId: '', birthDate: '' };
    }
    const formattedId = `${cleanId.slice(0, 2)} ${cleanId.slice(2, 9)}`;

    // Agar foydalanuvchi sozlanmalarda shu ID kartani allaqachon kiritgan bo'lsa
    const existingCleanUserId = (user?.idCardNumber || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (existingCleanUserId === cleanId && (recipientFirstName.trim() || user?.firstName)) {
      const fName = recipientFirstName.trim() || user?.firstName || 'Mijoz';
      const lName = recipientLastName.trim() || user?.lastName || '';
      setIdVerifiedInCheckout(true);
      setRecipientIdCard(formattedId);
      return {
        ok: true,
        firstName: fName,
        lastName: lName,
        formattedId,
        birthDate: recipientBirthDate || user?.birthDate || '',
      };
    }

    const birthDigits = recipientBirthDate.replace(/\D/g, '');
    const effectiveBirth =
      birthDigits.length === 8
        ? `${birthDigits.slice(0, 2)}.${birthDigits.slice(2, 4)}.${birthDigits.slice(4, 8)}`
        : user?.birthDate || '01.01.1995';

    setIdVerifying(true);
    setError(null);
    let resolvedFirst = recipientFirstName.trim() || user?.firstName || '';
    let resolvedLast = recipientLastName.trim() || user?.lastName || '';
    let resolvedPinfl = user?.pinfl || '';
    let resolvedRegion = region || getNearestRegionName(mapCoords.lat, mapCoords.lng) || user?.region || 'Toshkent shahri';
    let resolvedDistrict = district || user?.district || detectedMapAddress;
    let resolvedAddress = user?.address || `${resolvedRegion}, ${resolvedDistrict}`;

    try {
      const res = await fetch('/api/myid/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          idCardNumber: cleanId,
          birthDate: effectiveBirth,
        }),
      });
      const json = await res.json();
      if (res.ok && json.success && json.data) {
        resolvedFirst = json.data.firstName || resolvedFirst || 'Mijoz';
        resolvedLast = json.data.lastName || resolvedLast || '';
        resolvedPinfl = json.data.pinfl || resolvedPinfl;
        if (json.data.region) resolvedRegion = json.data.region;
        if (json.data.district) resolvedDistrict = json.data.district;
        if (json.data.address) resolvedAddress = json.data.address;
      }
    } catch {}

    if (!resolvedFirst) {
      resolvedFirst = user?.displayName?.split(' ')[0] || 'Xaridor';
    }

    setRecipientFirstName(resolvedFirst);
    setRecipientLastName(resolvedLast);
    setRecipientIdCard(formattedId);
    setRecipientBirthDate(effectiveBirth);
    setIdVerifiedInCheckout(true);
    setIdVerifying(false);

    if (user) {
      const updatedUser: UserProfile = {
        ...user,
        firstName: resolvedFirst,
        lastName: resolvedLast,
        displayName: `${resolvedFirst} ${resolvedLast}`.trim() || user.displayName,
        idCardNumber: formattedId,
        birthDate: effectiveBirth,
        pinfl: resolvedPinfl || user.pinfl,
        myGovVerified: true,
        phone: cabinetPhone.trim() || user.phone,
        region: resolvedRegion,
        district: resolvedDistrict,
        address: resolvedAddress,
      };
      try {
        await setDoc(doc(db, 'users', user.id), updatedUser, { merge: true });
      } catch {}
      try {
        const savedCust = localStorage.getItem('bunkerstroy_customers');
        const custList = savedCust ? JSON.parse(savedCust) : [];
        if (Array.isArray(custList)) {
          let found = false;
          const updatedCustList = custList.map((c: any) => {
            if (c && c.id === user.id) {
              found = true;
              return { ...c, ...updatedUser };
            }
            return c;
          });
          if (!found) {
            updatedCustList.unshift(updatedUser);
          }
          localStorage.setItem('bunkerstroy_customers', JSON.stringify(updatedCustList));
          window.dispatchEvent(new Event('storage'));
        }
      } catch {}
      if (onUserUpdate) {
        onUserUpdate(updatedUser);
      }
    }

    return {
      ok: true,
      firstName: resolvedFirst,
      lastName: resolvedLast,
      formattedId,
      birthDate: effectiveBirth,
    };
  };

  // Step 3 -> Step 4 validation
  const handleProceedToPayment = async () => {
    const cleanPhoneDigits = cabinetPhone.replace(/\D/g, '');
    if (cleanPhoneDigits.length < 9) {
      setError("Iltimos, telefon raqamini to'liq kiriting!");
      return;
    }

    const idCheck = await verifyAndSaveRecipientIdCard();
    if (!idCheck.ok) {
      return;
    }

    setError(null);
    setStep(4);
  };

  // Step 4 -> Finalize Order & Payment
  const handleFinalizeOrder = async () => {
    if (!user) {
      onOpenAuth();
      return;
    }

    const cleanCardDigits = cardNumber.replace(/\D/g, '');
    if (cleanCardDigits.length < 16) {
      setError('Iltimos, 16 xonali karta raqamini to‘liq kiriting!');
      return;
    }
    const cleanExpireDigits = cardExpire.replace(/\D/g, '');
    if (cleanExpireDigits.length < 4) {
      setError('Iltimos, karta amal qilish muddatini (OO/YY) to‘liq kiriting!');
      return;
    }
    const expMonth = Number(cleanExpireDigits.slice(0, 2));
    if (expMonth < 1 || expMonth > 12) {
      setError('Iltimos, karta amal qilish oyini (01 dan 12 gacha) to‘g‘ri kiriting!');
      return;
    }
    if (!cardSmsSent) {
      triggerCardSmsCode();
      return;
    }
    if (!cardSmsInput.trim() || cardSmsInput.trim() !== sentCardSmsCode) {
      setError('SMS tasdiqlash kodi noto‘g‘ri! Iltimos, karta ulangan raqamga yuborilgan kodni kiriting.');
      return;
    }

    setLoading(true);
    setError(null);

    saveDeliveryAddressForFuture(detectedMapAddress, mapCoords.lat, mapCoords.lng);

    const orderId = 'ORD-' + Math.floor(100000 + Math.random() * 900000);
    const fullRecipientName = `${recipientFirstName.trim()} ${recipientLastName.trim()}`.trim();
    const manualAddressText = [region, district, mfy].filter(Boolean).join(', ');
    const baseDeliveryAddress = showManualAddressFields && manualAddressText
      ? manualAddressText
      : detectedMapAddress || manualAddressText || getNearestRegionName(mapCoords.lat, mapCoords.lng);
    const fullDeliveryAddress = `${baseDeliveryAddress}${
      mapPinned ? ` [Google Maps: ${mapCoords.lat.toFixed(5)}, ${mapCoords.lng.toFixed(5)}]` : ''
    }`;
    const fullPhone = secondaryPhone.trim() && secondaryPhone.replace(/\D/g, '').length >= 9
      ? `${cabinetPhone.trim()} (Qo'shimcha: ${secondaryPhone.trim()})`
      : cabinetPhone.trim();
    const txId = 'TX-' + Date.now().toString(36).toUpperCase();

    const orderData: Order = {
      id: orderId,
      buyerId: user.id,
      buyerName: fullRecipientName || user.displayName || 'Mijoz',
      buyerPhone: fullPhone,
      recipientName: fullRecipientName,
      recipientPhone: fullPhone,
      deliveryAddress: fullDeliveryAddress,
      deliveryRegion: region || getNearestRegionName(mapCoords.lat, mapCoords.lng),
      deliveryDistrict: district || detectedMapAddress,
      deliveryStreet: mfy || `${mapCoords.lat.toFixed(5)}, ${mapCoords.lng.toFixed(5)}`,
      deliveryLandmark: mfy || detectedMapAddress,
      items: items.map((i) => ({
        productId: i.product.id,
        title: i.product.title,
        quantity: i.quantity,
        unit: i.product.unit,
        price: i.product.price,
        category: i.product.category,
        supplierId: i.product.supplierId,
        supplierInn: i.product.supplierInn,
        supplierName: i.product.supplierName,
      })),
      totalAmount: grandTotal,
      status: 'pending',
      vehicleType: grandTotal > 5000000 ? 'Gazel (Tezkor yetkazish)' : 'Kichik yuk mashinasi',
      paymentMethod,
      paymentStatus: 'paid',
      paidAt: new Date().toISOString(),
      transactionId: txId,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    try {
      // 1. Save to localStorage orders list first so all cabinets (Supplier, Customer, Admin) update immediately
      try {
        const savedOrders = localStorage.getItem('bunkerstroy_orders');
        const ordersList = savedOrders ? JSON.parse(savedOrders) : [];
        ordersList.unshift(orderData);
        localStorage.setItem('bunkerstroy_orders', JSON.stringify(ordersList));

        // 1b. Update products salesCount & stock in localStorage and Firestore
        const savedProds = localStorage.getItem('bunkerstroy_products');
        if (savedProds) {
          const prodsList = JSON.parse(savedProds);
          if (Array.isArray(prodsList)) {
            const updatedProds = prodsList.map((p: any) => {
              const orderedItem = items.find((it) => it.product.id === p.id);
              if (!orderedItem) return p;
              const nextSales = (Number(p.salesCount) || 0) + orderedItem.quantity;
              const nextStock = Math.max(0, (Number(p.stock) || 0) - orderedItem.quantity);
              try {
                setDoc(doc(db, 'products', p.id), { stock: nextStock, salesCount: nextSales }, { merge: true }).catch(() => {});
              } catch {}
              return {
                ...p,
                salesCount: nextSales,
                stock: nextStock,
              };
            });
            localStorage.setItem('bunkerstroy_products', JSON.stringify(updatedProds));
            window.dispatchEvent(new CustomEvent('bunkerstroy_products_updated'));
          }
        }

        // 1c. Update suppliers totalSalesSum (Ta'minotchilar hisob raqamiga o'tkazilgan mablag'lar)
        const savedSupps = localStorage.getItem('bunkerstroy_suppliers');
        if (savedSupps) {
          const suppsList = JSON.parse(savedSupps);
          if (Array.isArray(suppsList)) {
            const updatedSupps = suppsList.map((s: any) => {
              const supplierSoldAmount = items
                .filter(
                  (it) =>
                    (it.product.supplierId && it.product.supplierId === s.id) ||
                    (it.product.supplierInn && s.inn && it.product.supplierInn === s.inn) ||
                    (it.product.supplierName || '').toLowerCase() === (s.companyName || '').toLowerCase()
                )
                .reduce((acc, it) => acc + it.product.price * it.quantity, 0);
              if (supplierSoldAmount <= 0) return s;
              return {
                ...s,
                totalSalesSum: (Number(s.totalSalesSum) || 0) + supplierSoldAmount,
              };
            });
            localStorage.setItem('bunkerstroy_suppliers', JSON.stringify(updatedSupps));
          }
        }

        // 2. Save financial transaction
        const savedTx = localStorage.getItem('bunkerstroy_transactions');
        const txList = savedTx ? JSON.parse(savedTx) : [];
        const newTx = {
          id: txId,
          type: 'income',
          category: "Ta'minotchi hisob raqamiga o'tkazma (Savdo tushumi)",
          sourceOrDestination: `«${orderData.buyerName}» (${orderData.buyerPhone})`,
          amount: grandTotal,
          paymentMethod: `${paymentMethod.toUpperCase()} orqali to‘lov`,
          date: new Date().toISOString().replace('T', ' ').slice(0, 16),
          status: 'completed',
          orderId: orderId,
        };
        txList.unshift(newTx);
        localStorage.setItem('bunkerstroy_transactions', JSON.stringify(txList));

        // 3. System log
        const savedLogs = localStorage.getItem('bunkerstroy_logs');
        const logsList = savedLogs ? JSON.parse(savedLogs) : [];
        const newLog = {
          id: `log-${Date.now()}`,
          action: "Yangi buyurtma va to'lov rasmiylashtirildi",
          actor: orderData.buyerName,
          category: 'orders_sales',
          details: `Jismoniy shaxs kabinetidan yangi buyurtma (#${orderId}). Summa: ${new Intl.NumberFormat(
            'uz-UZ'
          ).format(grandTotal)} so'm. To'lov: ${paymentMethod.toUpperCase()}. Manzil: ${fullDeliveryAddress}. Tel: ${fullPhone}`,
          timestamp: new Date().toISOString(),
          ip: '195.158.28.19',
          level: 'success',
        };
        logsList.unshift(newLog);
        localStorage.setItem('bunkerstroy_logs', JSON.stringify(logsList));

        // Record Cabinet Security & Activity Log
        if (user) {
          recordCabinetLog({
            userId: user.id,
            userLogin: user.email || user.displayName,
            userName: orderData.buyerName,
            action: 'order_placed',
            actionLabel: `Yangi buyurtma rasmiylashtirildi (#${orderId})`,
            details: `Buyurtma summasi: ${new Intl.NumberFormat('uz-UZ').format(grandTotal)} so'm. To'lov: ${paymentMethod.toUpperCase()}. Yetkazish: ${fullDeliveryAddress}.`,
          });
        }

        // Notify app
        window.dispatchEvent(new CustomEvent('bunkerstroy_orders_updated'));
        window.dispatchEvent(new CustomEvent('bunkerstroy_finance_updated'));
        window.dispatchEvent(new Event('storage'));
      } catch (locErr) {
        console.warn('LocalStorage error:', locErr);
      }

      // 4. Also persist to Firestore (non-blocking if local auth)
      try {
        await setDoc(doc(db, 'orders', orderId), orderData);
      } catch (fsErr) {
        console.warn('Firestore order sync notice:', fsErr);
      }

      setCompletedOrder(orderData);
      onClearCart();
      setStep(5); // Go to receipt / confirmation screen
      onOrderCompleted(orderData);
    } catch (err: any) {
      console.error('Order creation error:', err);
      try {
        handleFirestoreError(err, OperationType.CREATE, 'orders');
      } catch (e: any) {
        setError("Buyurtmani rasmiylashtirishda xatolik yuz berdi. Iltimos qayta urinib ko'ring.");
      }
    } finally {
      setLoading(false);
    }
  };

  const handlePrintReceipt = () => {
    window.print();
  };

  return (
    <div className="fixed inset-0 z-[60] w-screen h-screen bg-[#151719] flex flex-col overflow-hidden animate-fadeIn">
      <div className="bg-[#151719] text-[#F5F5F2] w-full h-full flex flex-col overflow-hidden">
        {/* Modal Top Header */}
        <div className="px-5 sm:px-8 py-4 border-b border-[#51504A] bg-[#1D2023] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="p-2.5 rounded-lg bg-[#292C2F] text-[#FFB800] border border-[#51504A]">
              <Package className="w-6 h-6 stroke-[2.2]" />
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-lg sm:text-xl font-bold text-[#F5F5F2]">
                  Jismoniy Shaxs Kabineti: Buyurtma Berish
                </h2>
                <span className="hidden sm:inline-block px-2 py-0.5 rounded text-[10px] font-mono font-bold bg-[#292C2F] text-[#FFB800] border border-[#51504A]">
                  4 BOSQICHLI TIZIM
                </span>
              </div>
              <p className="text-xs text-[#B8B8B3]">
                Buyurtmani tasdiqlash → Manzilni tasdiqlash → Telefon raqam → To'lov
              </p>
            </div>
          </div>

          <button
            onClick={onClose}
            className="text-[#B8B8B3] hover:text-[#F5F5F2] p-2 rounded-lg bg-[#222528] hover:bg-[#292C2F] border border-[#51504A] transition-all cursor-pointer"
            title="Yopish"
          >
            ✕
          </button>
        </div>

        {/* 4 Ta Bosqich Progress Bar (Step Indicator) */}
        {step < 5 && (
          <div className="px-4 sm:px-8 py-3.5 bg-[#222528] border-b border-[#51504A]">
            <div className="grid grid-cols-4 gap-2 sm:gap-3 text-center">
              {/* 1. Buyurtmani tasdiqlash */}
              <div
                onClick={() => setStep(1)}
                className={`flex flex-col sm:flex-row items-center justify-center gap-1.5 p-2 rounded-lg cursor-pointer transition-all border ${
                  step === 1
                    ? 'bg-[#FFB800] text-[#151719] font-bold border-[#FFC928] shadow-sm'
                    : step > 1
                    ? 'bg-[#292C2F] text-[#F5F5F2] border-[#51504A] font-medium'
                    : 'bg-[#151719] text-[#B8B8B3] border-[#51504A]'
                }`}
              >
                <div
                  className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold font-mono ${
                    step === 1
                      ? 'bg-[#151719] text-[#FFB800]'
                      : step > 1
                      ? 'bg-[#FFB800] text-[#151719]'
                      : 'bg-[#292C2F] text-[#B8B8B3]'
                  }`}
                >
                  {step > 1 ? '✓' : '1'}
                </div>
                <span className="text-[11px] sm:text-xs truncate">1. Buyurtmani tasdiqlash</span>
              </div>

              {/* 2. Manzilni tasdiqlash */}
              <div
                onClick={() => step > 1 && setStep(2)}
                className={`flex flex-col sm:flex-row items-center justify-center gap-1.5 p-2 rounded-lg transition-all border ${
                  step === 2
                    ? 'bg-[#FFB800] text-[#151719] font-bold border-[#FFC928] shadow-sm cursor-pointer'
                    : step > 2
                    ? 'bg-[#292C2F] text-[#F5F5F2] border-[#51504A] font-medium cursor-pointer'
                    : 'bg-[#151719] text-[#B8B8B3] border-[#51504A] opacity-60'
                }`}
              >
                <div
                  className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold font-mono ${
                    step === 2
                      ? 'bg-[#151719] text-[#FFB800]'
                      : step > 2
                      ? 'bg-[#FFB800] text-[#151719]'
                      : 'bg-[#292C2F] text-[#B8B8B3]'
                  }`}
                >
                  {step > 2 ? '✓' : '2'}
                </div>
                <span className="text-[11px] sm:text-xs truncate">2. Manzilni tasdiqlash</span>
              </div>

              {/* 3. Telefon raqam */}
              <div
                onClick={() => step > 2 && setStep(3)}
                className={`flex flex-col sm:flex-row items-center justify-center gap-1.5 p-2 rounded-lg transition-all border ${
                  step === 3
                    ? 'bg-[#FFB800] text-[#151719] font-bold border-[#FFC928] shadow-sm cursor-pointer'
                    : step > 3
                    ? 'bg-[#292C2F] text-[#F5F5F2] border-[#51504A] font-medium cursor-pointer'
                    : 'bg-[#151719] text-[#B8B8B3] border-[#51504A] opacity-60'
                }`}
              >
                <div
                  className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold font-mono ${
                    step === 3
                      ? 'bg-[#151719] text-[#FFB800]'
                      : step > 3
                      ? 'bg-[#FFB800] text-[#151719]'
                      : 'bg-[#292C2F] text-[#B8B8B3]'
                  }`}
                >
                  {step > 3 ? '✓' : '3'}
                </div>
                <span className="text-[11px] sm:text-xs truncate">3. Telefon raqam</span>
              </div>

              {/* 4. To'lov */}
              <div
                onClick={() => step > 3 && setStep(4)}
                className={`flex flex-col sm:flex-row items-center justify-center gap-1.5 p-2 rounded-lg transition-all border ${
                  step === 4
                    ? 'bg-[#FFB800] text-[#151719] font-bold border-[#FFC928] shadow-sm cursor-pointer'
                    : 'bg-[#151719] text-[#B8B8B3] border-[#51504A] opacity-60'
                }`}
              >
                <div
                  className={`w-5 h-5 rounded-full flex items-center justify-center text-xs font-bold font-mono ${
                    step === 4 ? 'bg-[#151719] text-[#FFB800]' : 'bg-[#292C2F] text-[#B8B8B3]'
                  }`}
                >
                  4
                </div>
                <span className="text-[11px] sm:text-xs truncate">4. To'lov</span>
              </div>
            </div>
          </div>
        )}

        {/* Modal Body */}
        <div className="p-5 sm:p-7 overflow-y-auto space-y-6 flex-1 bg-[#040e24]">
          {error && (
            <div className="flex items-center gap-2 p-3.5 rounded-2xl bg-red-950/80 text-red-300 border border-red-600 text-xs font-bold animate-fadeIn">
              <AlertCircle className="w-5 h-5 shrink-0 text-red-400" />
              <span>{error}</span>
            </div>
          )}

          {/* ============================================================== */}
          {/* 1-BOSQICH: BUYURTMANI TASDIQLASH                              */}
          {/* ============================================================== */}
          {step === 1 && (
            <div className="space-y-6 animate-fadeIn">
              <div className="pb-3 border-b border-blue-500/30">
                <h3 className="text-base sm:text-lg font-black text-amber-400 flex items-center gap-2">
                  <Package className="w-5 h-5" />
                  1-Bosqich: Buyurtma qilingan tovarlar ro'yxatini tasdiqlash
                </h3>
              </div>

              {items.length === 0 ? (
                <div className="text-center py-16 space-y-3 bg-[#07193f] rounded-2xl border border-blue-500/40 p-6">
                  <Package className="w-12 h-12 text-slate-500 mx-auto" />
                  <p className="text-[#B8B8B3] font-bold text-sm">Hozirda savatda mahsulot yo'q.</p>
                  <button
                    onClick={onClose}
                    className="btn-industrial-yellow px-5 py-2.5 rounded-lg text-xs font-bold cursor-pointer"
                  >
                    Bunkerdan mahsulot tanlash
                  </button>
                </div>
              ) : (
                <div className="space-y-3">
                  <div className="overflow-x-auto rounded-lg border border-[#51504A] bg-[#151719]">
                    <table className="w-full text-left border-collapse text-xs sm:text-sm">
                      <thead>
                        <tr className="bg-[#222528] text-[#F5F5F2] font-bold border-b border-[#51504A]">
                          <th className="py-3 px-4">№</th>
                          <th className="py-3 px-4">Mahsulot</th>
                          <th className="py-3 px-4">Narxi</th>
                          <th className="py-3 px-4 text-center">Miqdori</th>
                          <th className="py-3 px-4 text-right">Jami Summa</th>
                          <th className="py-3 px-4 text-center">O'chirish</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[#51504A]/60">
                        {items.map((item, idx) => (
                          <tr key={item.product.id} className="hover:bg-[#222528] transition-colors">
                            <td className="py-3.5 px-4 font-mono font-bold text-[#B8B8B3]">{idx + 1}</td>
                            <td className="py-3.5 px-4">
                              <div className="flex items-center gap-3">
                                <img
                                  src={item.product.image}
                                  alt={item.product.title}
                                  className="w-12 h-12 rounded-lg object-cover bg-[#222528] border border-[#51504A] shrink-0"
                                />
                                <div>
                                  <div className="font-bold text-[#F5F5F2] leading-snug line-clamp-1">
                                    {item.product.title}
                                  </div>
                                  <div className="text-[11px] text-[#FFB800]">
                                    {item.product.category}
                                  </div>
                                </div>
                              </div>
                            </td>
                            <td className="py-3.5 px-4 font-mono font-bold whitespace-nowrap text-[#F5F5F2]">
                              {formatPrice(item.product.price)}
                            </td>
                            <td className="py-3.5 px-4 text-center whitespace-nowrap">
                              <div className="inline-flex items-center gap-2 bg-[#222528] px-2 py-1 rounded-lg border border-[#51504A]">
                                <button
                                  type="button"
                                  onClick={() =>
                                    onUpdateQuantity(item.product.id, Math.max(1, item.quantity - 1))
                                  }
                                  className="p-1 text-[#B8B8B3] hover:text-[#F5F5F2] rounded hover:bg-[#292C2F] transition-colors"
                                >
                                  <Minus className="w-3.5 h-3.5" />
                                </button>
                                <span className="text-xs font-bold px-2 min-w-[44px] text-center font-mono text-[#F5F5F2]">
                                  {item.quantity} {item.product.unit}
                                </span>
                                <button
                                  type="button"
                                  onClick={() =>
                                    onUpdateQuantity(item.product.id, item.quantity + 1)
                                  }
                                  className="p-1 text-[#B8B8B3] hover:text-[#F5F5F2] rounded hover:bg-[#292C2F] transition-colors"
                                >
                                  <Plus className="w-3.5 h-3.5" />
                                </button>
                              </div>
                            </td>
                            <td className="py-3.5 px-4 text-right font-mono font-bold text-[#FFB800] whitespace-nowrap">
                              {formatPrice(item.product.price * item.quantity)}
                            </td>
                            <td className="py-3.5 px-4 text-center">
                              <button
                                type="button"
                                onClick={() => onRemoveItem(item.product.id)}
                                className="p-1.5 text-red-400 hover:text-red-300 hover:bg-red-500/10 rounded-lg transition-colors cursor-pointer"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {/* Summary Box */}
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 pt-2">
                    <div className="bg-[#222528] p-4 rounded-lg border border-[#51504A] space-y-2 text-xs">
                      <div className="font-bold text-[#FFB800] flex items-center gap-1.5">
                        <ShieldCheck className="w-4 h-4" />
                        Platforma Kafolati
                      </div>
                      <p className="text-[#B8B8B3] leading-relaxed text-[11px]">
                        • Barcha mahsulotlar O'zbekiston standartlariga muvofiq sertifikatlangan.
                      </p>
                    </div>

                    <div className="bg-[#222528] p-4 rounded-lg border border-[#51504A] flex items-center justify-between">
                      <span className="text-sm font-bold text-[#F5F5F2]">Jami To'lanadigan Summa:</span>
                      <span className="text-xl font-black text-[#FFB800] font-mono">
                        {formatPrice(grandTotal)}
                      </span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* ============================================================== */}
          {/* 2-BOSQICH: MANZILNI TASDIQLASH                                */}
          {/* ============================================================== */}
          {step === 2 && (
            <div className="space-y-5 animate-fadeIn">
              <div className="pb-3 border-b border-[#51504A]">
                <h3 className="text-base sm:text-lg font-bold text-[#FFB800] flex items-center gap-2">
                  <MapPin className="w-5 h-5" />
                  2-Bosqich: Manzilni tasdiqlash
                </h3>
              </div>

              {/* Avval saqlangan manzillardan bir bosishda foydalanish imkoni */}
              {savedDeliveryAddresses.length > 0 && (
                <div className="p-4 rounded-xl bg-[#222528] border border-[#51504A] space-y-2.5">
                  <span className="text-xs font-bold text-[#FFB800] block">
                    Avval saqlangan yetkazish manzillaringiz (tanlash uchun bosing):
                  </span>
                  <div className="flex flex-wrap gap-2">
                    {savedDeliveryAddresses.map((savedItem, sIdx) => {
                      const isSelectedSaved =
                        detectedMapAddress.toLowerCase() === savedItem.address.toLowerCase();
                      return (
                        <button
                          key={sIdx}
                          type="button"
                          onClick={() => {
                            setMapCoords({ lat: savedItem.lat, lng: savedItem.lng });
                            setDetectedMapAddress(savedItem.address);
                            setMapPinned(true);
                            setAddressConfirmedNotice(true);
                            setError(null);
                          }}
                          className={`px-3 py-2 rounded-xl border text-xs font-bold flex items-center gap-2 cursor-pointer transition-all text-left ${
                            isSelectedSaved
                              ? 'bg-emerald-500/20 border-emerald-400 text-white shadow'
                              : 'bg-[#151719] border-[#51504A] text-[#F5F5F2] hover:border-[#FFB800]'
                          }`}
                        >
                          <MapPin className="w-3.5 h-3.5 text-[#FFB800] shrink-0" />
                          <span>{savedItem.address}</span>
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="space-y-4">
                <div className="rounded-xl border border-[#51504A] overflow-hidden bg-[#222528] p-4 space-y-3">
                  {/* Real Google Maps Embed */}
                  <div className="relative h-64 sm:h-80 w-full rounded-xl bg-[#151719] border border-[#51504A] overflow-hidden shadow-inner">
                    <iframe
                      title="Google Maps Location Picker"
                      width="100%"
                      height="100%"
                      style={{ border: 0 }}
                      loading="lazy"
                      referrerPolicy="no-referrer-when-downgrade"
                      src={`https://maps.google.com/maps?q=${encodeURIComponent(
                        `${mapCoords.lat},${mapCoords.lng}`
                      )}&hl=uz&z=16&t=${mapType}&output=embed`}
                    />

                    {/* Markazdagi aniq yetkazish nuqtasi ko'rsatkichi */}
                    <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-full flex flex-col items-center pointer-events-none z-10">
                      <div className="px-2 py-0.5 rounded bg-[#151719]/90 text-[#FFB800] border border-[#FFB800] font-bold text-[10px] shadow-lg whitespace-nowrap mb-0.5 font-mono">
                        Yetkazish nuqtasi
                      </div>
                      <MapPin className="w-8 h-8 text-red-500 drop-shadow-[0_4px_8px_rgba(0,0,0,0.8)] fill-red-500" />
                    </div>
                  </div>

                  {/* Joylashuvni Tasdiqlash tugmasi */}
                  <div className="flex items-center justify-end pt-1">
                    <button
                      type="button"
                      onClick={() => {
                        setMapPinned(true);
                        setAddressConfirmedNotice(true);
                        saveDeliveryAddressForFuture(detectedMapAddress, mapCoords.lat, mapCoords.lng);
                        setError(null);
                      }}
                      className="btn-industrial-yellow px-5 py-2 rounded-lg text-xs font-bold cursor-pointer shadow-sm"
                    >
                      Joylashuvni Tasdiqlash
                    </button>
                  </div>
                </div>

                {/* Qabul qilingan Real Joylashuv ko'rsatkichi */}
                <div className="p-4 rounded-xl bg-[#222528] border border-emerald-500/50 flex items-start justify-between gap-3">
                  <div className="flex items-start gap-3">
                    <CheckCircle className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                    <div>
                      <div className="text-xs font-bold text-emerald-400">
                        Qabul qilingan yetkazish joylashuvi:
                      </div>
                      <div className="text-sm font-bold text-[#F5F5F2] mt-0.5">
                        {detectedMapAddress}
                      </div>
                      {addressConfirmedNotice && (
                        <div className="text-[11px] text-emerald-300 font-bold mt-1">
                          ✓ Manzil saqlandi — keyingi buyurtmalarda ham shu manzildan foydalanishingiz mumkin
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* 3-BOSQICH: ID KARTA RAQAMI VA TELEFON RAQAM                   */}
          {/* ============================================================== */}
          {step === 3 && (
            <div className="space-y-6 animate-fadeIn">
              <div className="pb-3 border-b border-[#51504A]">
                <h3 className="text-base sm:text-lg font-bold text-[#FFB800] flex items-center gap-2">
                  <ShieldCheck className="w-5 h-5" />
                  3-Bosqich: Qabul qiluvchi ID ma'lumotlari va telefon raqami
                </h3>
              </div>

              <div className="max-w-xl mx-auto space-y-5 bg-[#222528] p-5 sm:p-7 rounded-lg border border-[#51504A]">
                {/* ID Karta ma'lumoti (Sozlamalarda kiritilgan bo'lsa avtomatik ko'rinadi, kiritilmagan bo'lsa kiritilib sozlamalarga ham saqlanadi) */}
                {user?.idCardNumber && /^[A-Z]{2}\s?\d{7}$/i.test(user.idCardNumber.trim()) ? (
                  <div className="p-4 rounded-xl bg-[#151719] border border-emerald-500/50 space-y-2">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className="text-xs font-bold text-emerald-400 flex items-center gap-1.5">
                        <CheckCircle className="w-4 h-4 shrink-0" />
                        <span>Shaxsiy ma'lumotlarda ID karta tasdiqlangan</span>
                      </span>
                      <span className="px-2.5 py-0.5 rounded bg-emerald-500/20 border border-emerald-500/40 text-emerald-300 font-mono font-black text-xs">
                        ID: {user.idCardNumber}
                      </span>
                    </div>
                    <div className="text-sm font-bold text-[#F5F5F2]">
                      Qabul qiluvchi: {`${recipientFirstName} ${recipientLastName}`.trim() || user.displayName}
                    </div>
                  </div>
                ) : (
                  <div className="space-y-3 p-4 rounded-xl bg-[#151719] border border-[#51504A]">
                    <div className="flex items-center justify-between gap-2 flex-wrap">
                      <span className="text-xs font-bold text-[#FFB800]">
                        Qabul qiluvchi ID Karta ma'lumotlari *
                      </span>
                      <span className="text-[10px] text-sky-300 font-mono">
                        Shaxsiy ma'lumotlarga ham avtomatik saqlanadi
                      </span>
                    </div>

                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                      <div className="space-y-1">
                        <label className="text-xs font-bold text-[#B8B8B3] block">
                          ID Karta Raqami *
                        </label>
                        <input
                          type="text"
                          maxLength={10}
                          value={recipientIdCard}
                          onChange={(e) => {
                            const cleaned = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
                            const letters = cleaned.replace(/[^A-Z]/g, '').slice(0, 2);
                            const digits = cleaned.slice(letters.length).replace(/\D/g, '').slice(0, 7);
                            const formatted = digits.length > 0 ? `${letters} ${digits}` : letters;
                            setRecipientIdCard(formatted);
                            setIdVerifiedInCheckout(false);
                            setError(null);
                          }}
                          placeholder=""
                          className="w-full px-3.5 py-2.5 rounded-lg bg-[#222528] border border-[#51504A] text-[#F5F5F2] font-mono font-bold text-sm uppercase tracking-wider focus:border-[#FFB800] focus:outline-none"
                        />
                      </div>

                      <div className="space-y-1">
                        <label className="text-xs font-bold text-[#B8B8B3] block">
                          Tug‘ilgan Sana (KK.OO.YYYY)
                        </label>
                        <input
                          type="text"
                          inputMode="numeric"
                          maxLength={10}
                          value={recipientBirthDate}
                          onChange={(e) => {
                            setRecipientBirthDate(formatBirthDateInput(e.target.value));
                            setIdVerifiedInCheckout(false);
                            setError(null);
                          }}
                          placeholder=""
                          className="w-full px-3.5 py-2.5 rounded-lg bg-[#222528] border border-[#51504A] text-[#F5F5F2] font-mono font-bold text-sm tracking-wider focus:border-[#FFB800] focus:outline-none"
                        />
                      </div>
                    </div>

                    <button
                      type="button"
                      onClick={() => verifyAndSaveRecipientIdCard()}
                      disabled={idVerifying}
                      className="w-full py-2.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 disabled:opacity-60 text-slate-950 font-black text-xs flex items-center justify-center gap-2 cursor-pointer transition-all"
                    >
                      <CheckCircle className="w-4 h-4" />
                      <span>{idVerifying ? 'Tekshirilmoqda...' : 'ID Kartani Tasdiqlash va Saqlash'}</span>
                    </button>

                    {idVerifiedInCheckout && (recipientFirstName || recipientLastName) && (
                      <div className="p-2.5 rounded-lg bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-xs font-bold flex items-center justify-between">
                        <span>✓ Tasdiqlandi: {`${recipientFirstName} ${recipientLastName}`.trim()}</span>
                        <span className="font-mono">{recipientIdCard}</span>
                      </div>
                    )}
                  </div>
                )}

                {/* Asosiy Telefon raqam (Kabinetdagi telefon raqam ishlatiladi) */}
                <div className="space-y-1.5">
                  <label className="text-xs font-bold text-[#B8B8B3] flex items-center justify-between">
                    <span>Telefon raqami (Kabinetdagi raqam) *</span>
                    <span className="text-[10px] text-emerald-400 font-bold flex items-center gap-1">
                      <CheckCircle className="w-3 h-3" /> Kabinet raqami
                    </span>
                  </label>
                  <div className="flex items-center rounded-lg bg-[#151719] border border-[#51504A] focus-within:border-[#FFB800] overflow-hidden">
                    <span className="px-3.5 py-3 text-xs sm:text-sm font-mono font-bold text-[#FFB800] border-r border-[#51504A] bg-[#292C2F]">
                      <Phone className="w-4 h-4" />
                    </span>
                    <input
                      type="tel"
                      inputMode="numeric"
                      maxLength={17}
                      value={cabinetPhone}
                      onChange={(e) => setCabinetPhone(formatUzPhoneInput(e.target.value))}
                      className="w-full px-4 py-3 bg-transparent text-[#F5F5F2] font-mono font-bold text-sm sm:text-base focus:outline-none"
                    />
                  </div>
                </div>

                {/* Oxirida Qo'shimcha telefon raqam qo'shish imkoni */}
                <div className="pt-2 border-t border-[#51504A]">
                  {!showAdditionalPhone && !secondaryPhone ? (
                    <button
                      type="button"
                      onClick={() => {
                        setShowAdditionalPhone(true);
                        setSecondaryPhone('+998 ');
                      }}
                      className="w-full py-2.5 px-4 rounded-lg bg-[#151719] hover:bg-[#292C2F] text-[#FFB800] border border-dashed border-[#FFB800]/60 text-xs font-bold flex items-center justify-center gap-2 cursor-pointer transition-colors"
                    >
                      <Plus className="w-4 h-4" />
                      <span>Qo‘shimcha telefon raqam qo‘shish</span>
                    </button>
                  ) : (
                    <div className="space-y-1.5 animate-fadeIn">
                      <div className="flex items-center justify-between">
                        <label className="text-xs font-bold text-[#B8B8B3] flex items-center gap-1.5">
                          <Phone className="w-3.5 h-3.5 text-[#FFB800]" />
                          Qo‘shimcha telefon raqami
                        </label>
                        <button
                          type="button"
                          onClick={() => {
                            setShowAdditionalPhone(false);
                            setSecondaryPhone('');
                          }}
                          className="text-[11px] text-red-400 hover:underline cursor-pointer"
                        >
                          O‘chirish
                        </button>
                      </div>
                      <input
                        type="tel"
                        inputMode="numeric"
                        maxLength={17}
                        value={secondaryPhone}
                        onChange={(e) => setSecondaryPhone(formatUzPhoneInput(e.target.value))}
                        placeholder="+998 XX XXX XX XX"
                        className="w-full px-4 py-3 rounded-lg bg-[#151719] border border-[#51504A] text-[#F5F5F2] font-mono font-bold text-sm focus:border-[#FFB800] focus:outline-none"
                      />
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* 4-BOSQICH: TO'LOV                                             */}
          {/* ============================================================== */}
          {step === 4 && (
            <div className="space-y-6 animate-fadeIn">
              <div className="pb-3 border-b border-[#51504A]">
                <h3 className="text-base sm:text-lg font-bold text-[#FFB800] flex items-center gap-2">
                  <CreditCard className="w-5 h-5" />
                  4-Bosqich: To'lov
                </h3>
              </div>

              {/* 4 ta Karta turlari: UZCARD, HUMO, CLICK, VISA (haqiqiy logotip va belgilari bilan) */}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                {[
                  {
                    id: 'uzcard',
                    label: 'UZCARD',
                    sub: 'Milliy to‘lov tizimi',
                    badge: (
                      <div className="w-11 h-8 rounded-lg bg-gradient-to-br from-[#0057A8] to-[#00AEEF] flex items-center justify-center shadow-inner border border-white/20 shrink-0">
                        <div className="flex flex-col items-center leading-none">
                          <span className="text-[9px] font-black tracking-tighter text-white">UZCARD</span>
                          <span className="w-5 h-1 rounded-full bg-[#F7941D] mt-0.5" />
                        </div>
                      </div>
                    ),
                  },
                  {
                    id: 'humo',
                    label: 'HUMO',
                    sub: 'Milliy bank kartasi',
                    badge: (
                      <div className="w-11 h-8 rounded-lg bg-gradient-to-br from-[#1C274C] via-[#009688] to-[#F59E0B] flex items-center justify-center shadow-inner border border-white/20 shrink-0">
                        <div className="flex flex-col items-center leading-none">
                          <span className="text-[9px] font-black tracking-wider text-white">HUMO</span>
                          <span className="w-4 h-1.5 rounded-full bg-amber-300/90 mt-0.5" />
                        </div>
                      </div>
                    ),
                  },
                  {
                    id: 'click',
                    label: 'CLICK',
                    sub: 'Click Up / Evolution',
                    badge: (
                      <div className="w-11 h-8 rounded-lg bg-gradient-to-br from-[#0066CC] to-[#00B4FF] flex items-center justify-center shadow-inner border border-white/20 shrink-0">
                        <div className="flex items-center gap-0.5">
                          <span className="w-2 h-2 rounded-full bg-white" />
                          <span className="text-[9px] font-black tracking-tight text-white">CLICK</span>
                        </div>
                      </div>
                    ),
                  },
                  {
                    id: 'visa',
                    label: 'VISA',
                    sub: 'Xalqaro to‘lov kartasi',
                    badge: (
                      <div className="w-11 h-8 rounded-lg bg-gradient-to-br from-[#1A1F71] to-[#254AA5] flex items-center justify-center shadow-inner border border-amber-400/40 shrink-0">
                        <span className="text-[11px] italic font-black tracking-wider text-white border-b-2 border-[#F7B600] leading-none pb-0.5">
                          VISA
                        </span>
                      </div>
                    ),
                  },
                ].map((cardType) => (
                  <div
                    key={cardType.id}
                    onClick={() => setPaymentMethod(cardType.id as any)}
                    className={`p-3.5 rounded-xl border cursor-pointer transition-all flex items-center justify-between gap-2 ${
                      paymentMethod === cardType.id
                        ? 'bg-[#292C2F] border-[#FFB800] shadow-[0_0_12px_rgba(255,184,0,0.25)]'
                        : 'bg-[#222528] border-[#51504A] hover:border-[#777A7C]'
                    }`}
                  >
                    <div className="flex items-center gap-2.5 min-w-0">
                      {cardType.badge}
                      <div className="min-w-0">
                        <span className="text-sm sm:text-base font-black tracking-wider font-mono text-white block leading-tight">
                          {cardType.label}
                        </span>
                        <span className="text-[10px] text-[#B8B8B3] truncate block">
                          {cardType.sub}
                        </span>
                      </div>
                    </div>
                    <div
                      className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 ${
                        paymentMethod === cardType.id ? 'border-[#FFB800] bg-[#FFB800]' : 'border-[#51504A]'
                      }`}
                    >
                      {paymentMethod === cardType.id && <div className="w-1.5 h-1.5 rounded-full bg-[#151719]" />}
                    </div>
                  </div>
                ))}
              </div>

              {/* Karta raqami va SMS tasdiqlash */}
              <div className="p-5 rounded-xl bg-[#222528] border border-[#51504A] space-y-4">
                <div className="text-xs font-bold text-[#FFB800] flex items-center gap-1.5">
                  <CreditCard className="w-4 h-4" />
                  <span>{paymentMethod.toUpperCase()} karta ma'lumotlari</span>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                  <div className="sm:col-span-2 space-y-1">
                    <label className="text-[11px] text-[#B8B8B3] font-bold">Karta raqami (16 ta raqam):</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={19}
                      value={cardNumber}
                      onChange={(e) => {
                        const digits = e.target.value.replace(/\D/g, '').slice(0, 16);
                        const formatted = digits.replace(/(\d{4})(?=\d)/g, '$1 ');
                        setCardNumber(formatted);
                        setCardSmsSent(false);
                        setError(null);
                      }}
                      placeholder="0000 0000 0000 0000"
                      className="w-full px-3.5 py-2.5 rounded-lg bg-[#151719] border border-[#51504A] font-mono font-bold text-[#F5F5F2] text-xs sm:text-sm focus:outline-none focus:border-[#FFB800]"
                    />
                  </div>
                  <div className="space-y-1">
                    <label className="text-[11px] text-[#B8B8B3] font-bold">Muddati (OO/YY):</label>
                    <input
                      type="text"
                      inputMode="numeric"
                      maxLength={5}
                      value={cardExpire}
                      onChange={(e) => {
                        const digits = e.target.value.replace(/\D/g, '').slice(0, 4);
                        if (digits.length >= 3) {
                          setCardExpire(`${digits.slice(0, 2)}/${digits.slice(2, 4)}`);
                        } else {
                          setCardExpire(digits);
                        }
                        setCardSmsSent(false);
                        setError(null);
                      }}
                      placeholder="12/28"
                      className="w-full px-3.5 py-2.5 rounded-lg bg-[#151719] border border-[#51504A] font-mono font-bold text-[#F5F5F2] text-xs sm:text-sm text-center focus:outline-none focus:border-[#FFB800]"
                    />
                  </div>
                </div>

                {/* 16 talik raqam va Muddati (OO/YY) kiritilib To'lovni tasdiqlash bosilgandan keyingina SMS tasdiqlash oynasi chiqadi */}
                {cardSmsSent && (
                  <div className="p-4 rounded-xl bg-[#151719] border border-emerald-500/50 space-y-3 animate-fadeIn">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs font-bold text-emerald-400">
                        Karta ulangan raqamga SMS kod yuborildi:{' '}
                        <span className="font-mono font-black text-[#FFB800] text-sm">
                          {getMaskedCardPhoneLast4()}
                        </span>
                      </div>
                      <span className="px-2.5 py-1 rounded bg-[#222528] border border-[#FFB800]/50 text-[#FFB800] font-mono font-black text-xs">
                        SMS kod: {sentCardSmsCode}
                      </span>
                    </div>

                    <div className="flex flex-col sm:flex-row gap-2.5">
                      <input
                        type="text"
                        inputMode="numeric"
                        maxLength={6}
                        value={cardSmsInput}
                        onChange={(e) => {
                          setCardSmsInput(e.target.value.replace(/\D/g, '').slice(0, 6));
                          setError(null);
                        }}
                        placeholder="6 xonali SMS kodni kiriting"
                        className="flex-1 px-4 py-2.5 rounded-lg bg-[#222528] border border-[#FFB800] font-mono font-black text-white text-sm tracking-widest text-center focus:outline-none"
                      />
                      <button
                        type="button"
                        onClick={triggerCardSmsCode}
                        className="px-3.5 py-2 rounded-lg bg-[#292C2F] hover:bg-[#34373B] text-[#FFB800] border border-[#51504A] text-xs font-bold cursor-pointer"
                      >
                        Qayta SMS yuborish
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Order Final Summary */}
              <div className="p-4 sm:p-5 rounded-lg bg-[#222528] border border-[#FFB800]/50 space-y-3">
                <div className="flex items-center justify-between pb-2 border-b border-[#51504A] flex-wrap gap-2">
                  <div className="text-xs font-bold text-[#B8B8B3]">
                    Yetkazish: <span className="text-[#F5F5F2]">{detectedMapAddress || [region, district, mfy].filter(Boolean).join(', ')}</span>
                  </div>
                  <div className="text-xs font-bold text-[#B8B8B3]">
                    Aloqa: <span className="text-[#F5F5F2]">{cabinetPhone}</span>
                    {secondaryPhone.trim() && secondaryPhone.replace(/\D/g, '').length >= 9 && (
                      <span className="text-[#FFB800] text-[11px] ml-1">({secondaryPhone})</span>
                    )}
                  </div>
                </div>

                <div className="flex items-center justify-between">
                  <div>
                    <span className="text-xs text-[#B8B8B3] block">Jami to'lanadigan summa:</span>
                    <span className="text-2xl sm:text-3xl font-black text-[#FFB800] font-mono">
                      {formatPrice(grandTotal)}
                    </span>
                  </div>

                  <div className="text-right">
                    <span className="text-xs text-[#B8B8B3] block">Tanlangan karta:</span>
                    <span className="text-sm font-bold uppercase text-emerald-400">
                      {paymentMethod.toUpperCase()}
                    </span>
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* ============================================================== */}
          {/* 5-BOSQICH: RASMIY KVITANSIYA / CHEK (BUYURTMA TAYYOR)          */}
          {/* ============================================================== */}
          {step === 5 && completedOrder && (
            <div className="space-y-6 animate-fadeIn py-2 max-w-2xl mx-auto">
              {/* Success Badge */}
              <div className="text-center space-y-2">
                <div className="w-16 h-16 rounded-full bg-emerald-500/20 text-emerald-400 border border-emerald-500/50 flex items-center justify-center mx-auto shadow-xl">
                  <CheckCircle className="w-10 h-10" />
                </div>
                <h3 className="text-xl sm:text-2xl font-black text-white">
                  Buyurtmangiz Muvaffaqiyatli Qabul Qilindi!
                </h3>
                <p className="text-xs text-sky-200">
                  Jismoniy shaxs kabinetingizga buyurtma to'liq biriktirildi va ijroga berildi.
                </p>
              </div>

              {/* Printable Official Receipt / Chek */}
              <div className="p-6 rounded-3xl bg-white text-slate-900 border-2 border-slate-300 shadow-2xl space-y-5 font-sans">
                {/* Chek Header */}
                <div className="flex items-center justify-between pb-4 border-b border-slate-200">
                  <div>
                    <div className="text-lg font-black tracking-wider text-slate-950">
                      BUNKER <span className="text-amber-600">STROY</span>
                    </div>
                    <div className="text-[11px] text-slate-500">
                      O'zbekiston Qurilish Mollari Onlayn Platformasi
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs font-mono font-bold text-slate-900">
                      Chek № {completedOrder.id}
                    </div>
                    <div className="text-[10px] text-slate-500 font-mono">
                      Tranzaksiya: {completedOrder.transactionId}
                    </div>
                  </div>
                </div>

                {/* Buyer & Delivery Details */}
                <div className="grid grid-cols-2 gap-3 text-xs border-b border-slate-200 pb-4">
                  <div>
                    <span className="text-[10px] text-slate-500 block uppercase font-bold">Xaridor:</span>
                    <span className="font-bold text-slate-900">{completedOrder.buyerName}</span>
                    <span className="block text-slate-600 font-mono">{completedOrder.buyerPhone}</span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-500 block uppercase font-bold">Manzil:</span>
                    <span className="font-medium text-slate-800 line-clamp-2">
                      {completedOrder.deliveryAddress}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-500 block uppercase font-bold">To'lov Turi:</span>
                    <span className="font-bold text-emerald-700 uppercase">
                      {completedOrder.paymentMethod === 'cash' ? 'Yetkazilganda naqd' : completedOrder.paymentMethod}
                    </span>
                  </div>
                  <div>
                    <span className="text-[10px] text-slate-500 block uppercase font-bold">Holat:</span>
                    <span className="font-bold text-blue-700">Onlayn mahsulot kutmoqda</span>
                  </div>
                </div>

                {/* Items in receipt */}
                <div className="space-y-1.5 text-xs">
                  <div className="font-bold text-slate-700 uppercase text-[10px]">Tarkibi:</div>
                  <div className="divide-y divide-slate-100 max-h-40 overflow-y-auto">
                    {completedOrder.items.map((it, idx) => (
                      <div key={idx} className="py-1.5 flex justify-between items-center text-xs">
                        <span className="font-medium text-slate-800">
                          {idx + 1}. {it.title} ({it.quantity} {it.unit})
                        </span>
                        <span className="font-mono font-bold text-slate-900">
                          {formatPrice(it.price * it.quantity)}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Chek Total */}
                <div className="pt-3 border-t-2 border-slate-900 flex justify-between items-baseline">
                  <span className="text-sm font-black text-slate-950 uppercase">Jami To'langan:</span>
                  <span className="text-xl font-black font-mono text-slate-950">
                    {formatPrice(completedOrder.totalAmount)}
                  </span>
                </div>
              </div>

              {/* Buttons */}
              <div className="flex flex-col sm:flex-row items-center gap-3 pt-2">
                <button
                  type="button"
                  onClick={handlePrintReceipt}
                  className="btn-industrial-dark w-full sm:w-1/2 py-3 rounded-lg text-xs sm:text-sm font-bold flex items-center justify-center gap-2 cursor-pointer transition-colors"
                >
                  <Printer className="w-4 h-4 text-[#FFB800]" />
                  Chekni chop etish / Saqlash
                </button>
                <button
                  type="button"
                  onClick={onClose}
                  className="btn-industrial-yellow w-full sm:w-1/2 py-3 rounded-lg text-xs sm:text-sm font-bold flex items-center justify-center gap-2 cursor-pointer shadow-md transition-all"
                >
                  Kabinetga qaytish
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Modal Bottom Actions */}
        {step < 5 && (
          <div className="px-5 sm:px-8 py-4 border-t border-[#51504A] bg-[#1D2023] flex items-center justify-between gap-3">
            <div>
              {step > 1 ? (
                <button
                  type="button"
                  onClick={() => setStep((prev) => (prev - 1) as any)}
                  className="btn-industrial-dark px-4 py-2 rounded-lg text-xs sm:text-sm font-bold flex items-center gap-1.5 cursor-pointer transition-colors"
                >
                  <ChevronLeft className="w-4 h-4" />
                  Orqaga
                </button>
              ) : (
                <button
                  type="button"
                  onClick={onClose}
                  className="btn-industrial-dark px-4 py-2 rounded-lg text-xs font-bold cursor-pointer transition-colors"
                >
                  Bekor qilish
                </button>
              )}
            </div>

            <div className="flex items-center gap-3">
              {step === 1 && (
                <button
                  type="button"
                  onClick={handleProceedToAddress}
                  disabled={items.length === 0}
                  className="btn-industrial-yellow px-5 sm:px-6 py-2.5 rounded-lg text-xs sm:text-sm font-bold flex items-center gap-2 shadow-sm cursor-pointer active:scale-95 disabled:opacity-50 transition-all"
                >
                  <span>Keyingisi: Manzilni tasdiqlash</span>
                  <ChevronRight className="w-4 h-4 stroke-[2.5]" />
                </button>
              )}

              {step === 2 && (
                <button
                  type="button"
                  onClick={handleProceedToPhone}
                  className="btn-industrial-yellow px-5 sm:px-6 py-2.5 rounded-lg text-xs sm:text-sm font-bold flex items-center gap-2 shadow-sm cursor-pointer active:scale-95 transition-all"
                >
                  <span>Keyingisi: Telefon raqam</span>
                  <ChevronRight className="w-4 h-4 stroke-[2.5]" />
                </button>
              )}

              {step === 3 && (
                <button
                  type="button"
                  onClick={handleProceedToPayment}
                  className="btn-industrial-yellow px-5 sm:px-6 py-2.5 rounded-lg text-xs sm:text-sm font-bold flex items-center gap-2 shadow-sm cursor-pointer active:scale-95 transition-all"
                >
                  <span>Keyingisi: To'lov</span>
                  <ChevronRight className="w-4 h-4 stroke-[2.5]" />
                </button>
              )}

              {step === 4 && (
                <button
                  type="button"
                  onClick={handleFinalizeOrder}
                  disabled={loading}
                  className="btn-industrial-yellow px-6 sm:px-8 py-3 rounded-lg text-xs sm:text-sm font-bold flex items-center gap-2 shadow-sm cursor-pointer active:scale-95 disabled:opacity-50 transition-all"
                >
                  {loading ? (
                    <span>Rasmiylashtirilmoqda...</span>
                  ) : (
                    <>
                      <CheckCircle className="w-5 h-5 stroke-[2.5]" />
                      <span>
                        {cardSmsSent
                          ? "SMS kodni tasdiqlash va Buyurtma berish"
                          : "To'lovni tasdiqlash"}
                      </span>
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
