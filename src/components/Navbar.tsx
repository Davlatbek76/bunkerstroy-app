import React, { useState, useRef, useEffect } from 'react';
import { ShoppingCart, User as UserIcon, HardHat, Building, ChevronDown } from 'lucide-react';
import { UserProfile } from '../types';
import { useLanguage, AppLanguage } from '../lib/i18n';

interface NavbarProps {
  activeTab: 'marketplace' | 'logistics' | 'global_bunker' | 'orders' | 'admin' | 'bunker_admin' | 'supplier' | 'cart_bunker';
  setActiveTab: (tab: any) => void;
  cartCount: number;
  onOpenCart: () => void;
  user: UserProfile | null;
  onOpenAuth: () => void;
  onLogout: () => void;
  onOpenLogsModal?: () => void;
  logoUrl?: string | null;
  telegram?: string;
  instagram?: string;
  phone?: string;
}

export const Navbar: React.FC<NavbarProps> = ({
  activeTab,
  setActiveTab,
  cartCount,
  onOpenCart,
  user,
  onOpenAuth,
  logoUrl,
}) => {
  const { lang, setLang, t } = useLanguage();
  const [isLangOpen, setIsLangOpen] = useState(false);
  const langMenuRef = useRef<HTMLDivElement | null>(null);
  const isAdmin = user?.role === 'admin' || user?.role === 'bunker_admin';
  const isSupplier = user?.role === 'supplier';

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (langMenuRef.current && !langMenuRef.current.contains(e.target as Node)) {
        setIsLangOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleLogoClick = () => {
    setActiveTab('marketplace');
  };

  const getUserInitials = (u: UserProfile | null) => {
    if (!u) return 'BS';
    if (u.role === 'admin') return 'BA';
    const f = (u.firstName || '').trim().charAt(0);
    const l = (u.lastName || '').trim().charAt(0);
    if (f && l) return (f + l).toUpperCase();
    if (f) return f.toUpperCase();
    if (u.displayName) {
      const parts = u.displayName.trim().split(/\s+/);
      if (parts.length >= 2 && parts[0] && parts[1]) {
        return (parts[0][0] + parts[1][0]).toUpperCase();
      }
      return parts[0].slice(0, 2).toUpperCase();
    }
    return 'BS';
  };

  const currentLangLabel = lang === 'ru' ? 'РУ' : lang === 'uz_cyrl' ? 'ЎЗ' : 'O‘Z';

  return (
    <header className="sticky top-0 z-50 w-full bg-8k-navy-header text-white">
      <div className="h-[3px] w-full bg-[#FFB800] opacity-95" />

      <div className="w-full px-2.5 sm:px-6 lg:px-10 pt-2.5 sm:pt-0">
        <div className="relative flex items-center justify-between h-11 sm:h-14 mt-1.5 sm:mt-0 gap-1.5">
          
          {/* Brand Logo (Ozgina kattalashtirilgan BUNKER STROY) */}
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <div 
              onClick={handleLogoClick}
              className="flex items-center gap-2 sm:gap-2.5 cursor-pointer group select-none py-0.5 min-w-0"
              title="BunkerStroy (Asosiy sahifa)"
            >
              {logoUrl ? (
                <div className="relative p-0.5 rounded-lg bg-[#0F2547] border border-[#254B85] group-hover:border-[#FFB800] transition-colors shrink-0">
                  <img
                    src={logoUrl}
                    alt="BunkerStroy Logo"
                    className="w-6 h-6 sm:w-8 sm:h-8 object-contain rounded"
                  />
                </div>
              ) : (
                <div className="relative w-7 h-7 sm:w-9 sm:h-9 rounded-lg bg-[#0F2547] border border-[#254B85] group-hover:border-[#FFB800] flex items-center justify-center transition-all shadow-sm shrink-0">
                  <HardHat className="w-4 h-4 sm:w-5 sm:h-5 text-[#FFB800] stroke-[2.2]" />
                </div>
              )}
              
              <div className="flex flex-col min-w-0">
                <span className="text-sm sm:text-xl lg:text-2xl font-black tracking-wide leading-none truncate">
                  <span className="text-[#FFB800]">BUNKER</span>{' '}
                  <span className="text-white">STROY</span>
                </span>
              </div>
            </div>
          </div>

          {/* Right Action Buttons: Til tanlash (O'Z / ЎЗ / РУ birlashtirilgan tugma) + Kabinetga Kirish */}
          <div className="flex items-center gap-1.5 sm:gap-2.5 shrink-0">

            {/* Birlashtirilgan Til Tugmasi (Bosilganda O'Z, ЎЗ, РУ tugmalari ko'rinadi) */}
            <div ref={langMenuRef} className="relative">
              <button
                type="button"
                onClick={() => setIsLangOpen((prev) => !prev)}
                className="liquid-glass-btn-navy flex items-center gap-1 px-2.5 sm:px-3 py-1 sm:py-1.5 rounded-xl text-[10px] sm:text-xs font-black text-white cursor-pointer"
                title="Tilni tanlash"
              >
                <span className="text-[#FFB800] font-mono">{currentLangLabel}</span>
                <ChevronDown className={`w-3 h-3 text-white transition-transform duration-150 ${isLangOpen ? 'rotate-180' : ''}`} />
              </button>

              {isLangOpen && (
                <div className="absolute right-0 mt-1.5 p-1.5 rounded-xl liquid-glass-settings-window flex items-center gap-1 z-50 shadow-2xl">
                  {(
                    [
                      { code: 'uz' as AppLanguage, label: 'O‘Z' },
                      { code: 'uz_cyrl' as AppLanguage, label: 'ЎЗ' },
                      { code: 'ru' as AppLanguage, label: 'РУ' },
                    ]
                  ).map((item) => (
                    <button
                      key={item.code}
                      type="button"
                      onClick={() => {
                        setLang(item.code);
                        setIsLangOpen(false);
                      }}
                      className={`px-2.5 py-1.5 rounded-lg text-[11px] sm:text-xs font-black font-mono cursor-pointer transition-colors ${
                        lang === item.code
                          ? 'liquid-glass-tab-active'
                          : 'liquid-glass-tab-inactive'
                      }`}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Auth / Profile Button (Mobilda "Kirish", kompyuterda "Kabinetga Kirish" - Liquid Glass) */}
            {user && !isAdmin ? (
              <div className="flex items-center gap-1 sm:gap-1.5">
                <button
                  onClick={() => {
                    if (isSupplier) {
                      setActiveTab('supplier');
                    } else {
                      setActiveTab('orders');
                    }
                  }}
                  className={`flex items-center gap-1.5 px-2.5 sm:px-3 py-1 sm:py-1.5 rounded-xl text-[10px] sm:text-xs cursor-pointer ${
                    (isSupplier && activeTab === 'supplier') ||
                    (!isSupplier && activeTab === 'orders')
                      ? 'liquid-glass-tab-active font-black'
                      : 'liquid-glass-btn-navy font-bold'
                  }`}
                  title={isSupplier ? t("Ta'minotchi Kabineti", 'Кабинет поставщика') : t("Mijoz Kabineti", 'Кабинет клиента')}
                >
                  <div className="w-4 h-4 sm:w-5 sm:h-5 rounded bg-[#071326] text-[#FFB800] font-mono font-bold flex items-center justify-center text-[9px] sm:text-[10px] border border-[#2E5A9C]">
                    {getUserInitials(user)}
                  </div>
                  <span className={`max-w-[90px] sm:max-w-[120px] truncate hidden sm:inline font-bold ${
                    (isSupplier && activeTab === 'supplier') || (!isSupplier && activeTab === 'orders')
                      ? 'text-[#071326]'
                      : 'text-white'
                  }`}>
                    {isSupplier ? (user.companyName || t("Ta'minotchi", 'Поставщик')) : (user.firstName || user.displayName || t('Kabinet', 'Кабинет'))}
                  </span>
                </button>
              </div>
            ) : (
              <button
                onClick={onOpenAuth}
                className="liquid-glass-btn-red flex items-center gap-1 sm:gap-1.5 px-2.5 sm:px-3.5 py-1 sm:py-1.5 rounded-xl text-[10px] sm:text-xs font-bold cursor-pointer whitespace-nowrap"
              >
                <UserIcon className="w-3 h-3 sm:w-3.5 sm:h-3.5 stroke-[2.5] text-white shrink-0" />
                <span className="text-white font-bold sm:hidden">{t('Kirish', 'Войти')}</span>
                <span className="text-white font-bold hidden sm:inline">{t('Kabinetga Kirish', 'Войти в кабинет')}</span>
              </button>
            )}

          </div>
        </div>

        {/* Bottom Navigation bar: Mahsulotlar, B2B Bunker va Savat bir qatorda, tugma emas qalin oq yozuv sifatida */}
        <div className="relative flex items-center justify-center sm:border-t sm:border-white/15 py-2 sm:py-2.5 gap-5 sm:gap-10">
          <button
            type="button"
            onClick={() => setActiveTab('marketplace')}
            className={`bg-transparent border-0 p-0 pb-1 text-xs sm:text-base font-black text-white tracking-wide whitespace-nowrap cursor-pointer transition-all ${
              activeTab === 'marketplace'
                ? 'border-b-2 border-[#FFB800]'
                : 'opacity-90 hover:opacity-100'
            }`}
          >
            {t('Mahsulotlar', 'Товары')}
          </button>

          <button
            type="button"
            onClick={() => setActiveTab('global_bunker')}
            className={`bg-transparent border-0 p-0 pb-1 text-xs sm:text-base font-black text-white tracking-wide whitespace-nowrap cursor-pointer transition-all ${
              activeTab === 'global_bunker'
                ? 'border-b-2 border-[#FFB800]'
                : 'opacity-90 hover:opacity-100'
            }`}
          >
            {t('B2B Bunker', 'B2B Бункер')}
          </button>

          <button
            type="button"
            onClick={onOpenCart}
            className="bg-transparent border-0 p-0 pb-1 text-xs sm:text-base font-black text-white tracking-wide whitespace-nowrap cursor-pointer flex items-center gap-1.5 opacity-95 hover:opacity-100 transition-all"
            aria-label={t('Savat', 'Корзина')}
            title={t('Savat', 'Корзина')}
          >
            <ShoppingCart className={`w-4 h-4 sm:w-4.5 sm:h-4.5 ${cartCount > 0 ? 'text-emerald-400' : 'text-[#FFB800]'}`} />
            <span className="text-white font-black">{t('Savat', 'Корзина')}</span>
            {cartCount > 0 && (
              <span className="bg-emerald-600 text-white text-[10px] sm:text-xs font-black font-mono px-1.5 py-0.2 rounded-md min-w-[18px] text-center border border-emerald-300">
                {cartCount}
              </span>
            )}
          </button>

          {isSupplier && (
            <button
              type="button"
              onClick={() => setActiveTab('supplier')}
              className="bg-transparent border-0 p-0 pb-1 text-xs sm:text-base font-black text-white flex items-center gap-1.5 cursor-pointer whitespace-nowrap opacity-90 hover:opacity-100"
            >
              <Building className="w-4 h-4 text-[#FFB800]" />
              <span>{t("Ta'minotchi", 'Поставщик')}</span>
            </button>
          )}
        </div>

      </div>
    </header>
  );
};


