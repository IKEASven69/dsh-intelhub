import React from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Routes, Route, NavLink } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import './i18n'; // side-effect: initializes i18next before any component renders
import './styles.css';
import { Database, Search, Network, CalendarClock, Zap, FlaskConical, FileOutput, Stethoscope, Sun, Moon, MessagesSquare, Users, CircleHelp, Home } from 'lucide-react';
import { DetailProvider } from './components/DetailDrawer';
import GradientText from './components/anim/GradientText';
import { HippoLogo } from './components/HippoLogo';
import StatusBar from './components/StatusBar';
import MemoriesPage from './pages/Memories';
import SessionsPage from './pages/Sessions';
import TeamPage from './pages/Team';
import LifePage from './pages/Life';
import RecallPage from './pages/Recall';
import GraphPage from './pages/Graph';
import TimelinePage from './pages/Timeline';
import PatternsPage from './pages/Patterns';
import DistillPage from './pages/Distill';
import CompilePage from './pages/Compile';
import DoctorPage from './pages/Doctor';

function ThemeToggle({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation();
  const [theme, setTheme] = useState<string>(() => {
    const saved = localStorage.getItem('hippo-theme');
    if (saved) return saved;
    return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  });
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem('hippo-theme', theme);
  }, [theme]);
  if (compact) {
    return (
      <button className="icon-btn" title={theme === 'dark' ? t('common.light') : t('common.dark')}
        onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')}>
        {theme === 'dark' ? <Sun size={14} /> : <Moon size={14} />}
      </button>
    );
  }
  return (
    <button className="theme-btn" onClick={() => setTheme(t => t === 'dark' ? 'light' : 'dark')} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      {theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
      <span>{theme === 'dark' ? t('common.light') : t('common.dark')}</span>
    </button>
  );
}

function LanguageToggle({ compact = false }: { compact?: boolean }) {
  const { i18n } = useTranslation();
  const lang = i18n.language?.startsWith('zh') ? 'zh' : 'en';
  if (compact) {
    return (
      <button className="icon-btn" title="中/EN" onClick={() => i18n.changeLanguage(lang === 'zh' ? 'en' : 'zh')}>
        {lang === 'zh' ? '中' : 'EN'}
      </button>
    );
  }
  return (
    <div className="lang-toggle">
      <button className={lang === 'zh' ? 'active' : ''} onClick={() => i18n.changeLanguage('zh')}>中</button>
      <button className={lang === 'en' ? 'active' : ''} onClick={() => i18n.changeLanguage('en')}>EN</button>
    </div>
  );
}


// ── spotlight 导游教程：每步高亮一个真实 UI 元素 + 定位气泡（上一步/下一步/跳过）──
function HelpButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button className="icon-btn" title='使用指南' onClick={() => setOpen(true)}>
        <CircleHelp size={14} />
      </button>
      {open && <SpotlightTour onClose={() => setOpen(false)} />}
    </>
  );
}

interface TourStep { selector: string; title: string; body: string }

function SpotlightTour({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const steps: TourStep[] = [
    { selector: 'a[href="/sessions"]', title: t('tour.s1t'), body: t('tour.s1b') },
    { selector: 'a[href="/distill"]', title: t('tour.s2t'), body: t('tour.s2b') },
    { selector: 'a[href="/"]', title: t('tour.s3t'), body: t('tour.s3b') },
    { selector: 'a[href="/team"]', title: t('tour.s4t'), body: t('tour.s4b') },
  ];
  const [idx, setIdx] = useState(0);
  const [rect, setRect] = useState<DOMRect | null>(null);

  useEffect(() => {
    const el = document.querySelector(steps[idx].selector);
    if (el) {
      el.scrollIntoView({ block: 'nearest' });
      setRect(el.getBoundingClientRect());
    } else {
      setRect(null);
    }
  }, [idx]);

  const step = steps[idx];
  const isLast = idx === steps.length - 1;

  // 气泡定位：目标下方优先，放不下则上方
  const bubbleStyle = (): React.CSSProperties => {
    if (!rect) return { top: '50%', left: '50%', transform: 'translate(-50%, -50%)' };
    const below = rect.bottom + 12;
    const canBelow = below + 180 < window.innerHeight;
    const top = canBelow ? below : Math.max(12, rect.top - 192);
    return { top, left: Math.min(Math.max(12, rect.right + 16), window.innerWidth - 340) };
  };

  return (
    <>
      {/* 遮罩 + 目标挖洞（box-shadow 巨幕法） */}
      {rect && (
        <div className="tour-hole" style={{
          top: rect.top - 6, left: rect.left - 6,
          width: rect.width + 12, height: rect.height + 12,
          boxShadow: '0 0 0 9999px rgba(0,0,0,.55)',
        }} />
      )}
      <div className="tour-bubble" style={bubbleStyle()}>
        <div className="tour-progress">{idx + 1} / {steps.length}</div>
        <b>{step.title}</b>
        <div className="meta" style={{ margin: '6px 0 12px', fontSize: 12.5, lineHeight: 1.6 }}>{step.body}</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn" onClick={onClose}>{t('tour.skip')}</button>
          <span style={{ flex: 1 }} />
          {idx > 0 && <button className="btn" onClick={() => setIdx(idx - 1)}>← {t('tour.prev')}</button>}
          <button className="btn primary" onClick={() => (isLast ? onClose() : setIdx(idx + 1))}>
            {isLast ? t('tour.finish') : `${t('tour.next')} →`}
          </button>
        </div>
      </div>
    </>
  );
}

function FirstVisitTour() {
  const [show, setShow] = useState(!localStorage.getItem('hippo-toured'));
  useEffect(() => { if (show) localStorage.setItem('hippo-toured', '1'); }, [show]);
  if (!show) return null;
  return <SpotlightTour onClose={() => setShow(false)} />;
}

function Shell() {
  const { t } = useTranslation();
  const linkClass = ({ isActive }: { isActive: boolean }) => 'nav-link' + (isActive ? ' active' : '');
  return (
    <div className="app">
      <aside className="sidebar">
        <h1><HippoLogo size={24} /> <GradientText>hippo</GradientText></h1>
        <div className="nav-group">{t('nav.gData')}</div>
        <NavLink to="/sessions" className={linkClass}><MessagesSquare /> {t('nav.sessions')}</NavLink>
        <NavLink to="/" end className={linkClass}><Database /> {t('nav.memories')}</NavLink>
        <div className="nav-group">{t('nav.gExtract')}</div>
        <NavLink to="/distill" className={linkClass}><FlaskConical /> {t('nav.distill')}</NavLink>
        <NavLink to="/compile" className={linkClass}><FileOutput /> {t('nav.compile')}</NavLink>
        <div className="nav-group">{t('nav.gViews')}</div>
        <NavLink to="/recall" className={linkClass}><Search /> {t('nav.recall')}</NavLink>
        <NavLink to="/graph" className={linkClass}><Network /> {t('nav.graph')}</NavLink>
        <NavLink to="/timeline" className={linkClass}><CalendarClock /> {t('nav.timeline')}</NavLink>
        <NavLink to="/patterns" className={linkClass}><Zap /> {t('nav.patterns')}</NavLink>
        <div className="nav-group">{t('nav.gAgents')}</div>
        <NavLink to="/team" className={linkClass}><Users /> {t('nav.team')}</NavLink>
        <NavLink to="/life" className={linkClass}><Home /> {t('nav.life')}</NavLink>
        <div className="nav-group">{t('nav.gSystem')}</div>
        <NavLink to="/doctor" className={linkClass}><Stethoscope /> {t('nav.doctor')}</NavLink>
        <div className="spacer" />
        <div className="meta">{t('common.localFirst')}</div>
      </aside>
      <main className="main">
        <div className="topbar">
          <span className="spacer" />
          <LanguageToggle compact />
          <ThemeToggle compact />
          <HelpButton />
        </div>
        <StatusBar />
        <FirstVisitTour />
        <Routes>
          <Route path="/" element={<MemoriesPage />} />
          <Route path="/sessions" element={<SessionsPage />} />
          <Route path="/team" element={<TeamPage />} />
          <Route path="/life" element={<LifePage />} />
          <Route path="/recall" element={<RecallPage />} />
          <Route path="/graph" element={<GraphPage />} />
          <Route path="/timeline" element={<TimelinePage />} />
          <Route path="/patterns" element={<PatternsPage />} />
          <Route path="/distill" element={<DistillPage />} />
          <Route path="/compile" element={<CompilePage />} />
          <Route path="/doctor" element={<DoctorPage />} />
        </Routes>
      </main>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <BrowserRouter basename={window.__HIPPO_BASE__ || undefined}>
      <DetailProvider>
        <Shell />
      </DetailProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
