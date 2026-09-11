import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './state/auth';
import { ToastProvider } from './state/toast';
import { ComposeProvider } from './state/compose';
import { PgpProvider } from './state/pgp';
import { FeaturesProvider } from './state/features';
import { AssistantProvider } from './state/assistant';
import { Shell } from './components/Shell';
import BriefPage from './pages/Brief';
import CommitmentsPage from './pages/Commitments';
import { Spinner } from './components/ui';

// Eager: the two screens that can be the first paint. Everything else is a
// place you navigate to, and paid for when you go there — the settings and
// admin pages alone are a third of the bundle, and most sessions never open
// them.
import LoginPage from './pages/Login';
import MailPage from './pages/Mail';

const SetupPage = lazy(() => import('./pages/Setup'));
const RegisterPage = lazy(() => import('./pages/Register'));
const RespondersPage = lazy(() => import('./pages/Responders'));
const ContactsPage = lazy(() => import('./pages/Contacts'));
const TemplatesPage = lazy(() => import('./pages/Templates'));
const SequencesPage = lazy(() => import('./pages/Sequences'));
const SequenceEditorPage = lazy(() => import('./pages/SequenceEditor'));
const SequenceRepliesPage = lazy(() => import('./pages/SequenceReplies'));
const RulesPage = lazy(() => import('./pages/Rules'));
const ReviewPage = lazy(() => import('./pages/Review'));
const SettingsPage = lazy(() => import('./pages/Settings'));
const AdminSettingsPage = lazy(() => import('./pages/AdminSettings'));
const HomePage = lazy(() => import('./pages/Home'));
const CalendarPage = lazy(() => import('./pages/Calendar'));

// A chunk usually arrives in the same frame it is asked for, so the fallback
// exists to be correct rather than to be seen; it is deliberately quiet.
function Loading() {
  return <div className="center route-loading" role="status" aria-label="Loading"><Spinner size={22} /></div>;
}

function Gate() {
  const { user, loading, needsSetup } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="center" style={{ height: '100vh' }}><Spinner size={26} /></div>;
  if (needsSetup) return loc.pathname === '/setup' ? <Suspense fallback={<Loading />}><SetupPage /></Suspense> : <Navigate to="/setup" replace />;
  if (!user) return loc.pathname === '/login' ? <LoginPage /> : loc.pathname === '/register' ? <Suspense fallback={<Loading />}><RegisterPage /></Suspense> : <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (loc.pathname === '/login' || loc.pathname === '/setup' || loc.pathname === '/register') return <Navigate to="/mail/inbox" replace />;
  return (
    <Shell>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<Navigate to="/mail/inbox" replace />} />
          <Route path="/home" element={<HomePage />} />
        <Route path="/brief" element={<BriefPage />} />
        <Route path="/commitments" element={<CommitmentsPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/mail/:box" element={<MailPage />} />
          <Route path="/mail/:box/t/:threadKey" element={<MailPage />} />
          <Route path="/contacts" element={<ContactsPage />} />
          <Route path="/contacts/:id" element={<ContactsPage />} />
          <Route path="/templates" element={<TemplatesPage />} />
          <Route path="/sequences" element={<SequencesPage />} />
          <Route path="/sequences/replies" element={<SequenceRepliesPage />} />
          <Route path="/sequences/:id" element={<SequenceEditorPage />} />
          <Route path="/rules" element={<RulesPage />} />
          <Route path="/responders" element={<RespondersPage />} />
          <Route path="/review" element={<ReviewPage />} />
          <Route path="/settings/*" element={<SettingsPage />} />
          <Route path="/admin/*" element={<AdminSettingsPage />} />
          <Route path="*" element={<Navigate to="/mail/inbox" replace />} />
        </Routes>
      </Suspense>
    </Shell>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <FeaturesProvider>
          <PgpProvider>
            <ComposeProvider>
              {/* Inside ComposeProvider, because a draft the assistant
                  proposes opens a composer, and outside the router, because
                  the panel survives navigation — a question asked about one
                  conversation is still worth reading after you have moved on
                  to the next. */}
              <AssistantProvider>
                <Gate />
              </AssistantProvider>
            </ComposeProvider>
          </PgpProvider>
        </FeaturesProvider>
      </AuthProvider>
    </ToastProvider>
  );
}
