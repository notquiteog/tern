import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AuthProvider, useAuth } from './state/auth';
import { ToastProvider } from './state/toast';
import { ComposeProvider } from './state/compose';
import { PgpProvider } from './state/pgp';
import { Shell } from './components/Shell';
import LoginPage from './pages/Login';
import SetupPage from './pages/Setup';
import RegisterPage from './pages/Register';
import RespondersPage from './pages/Responders';
import MailPage from './pages/Mail';
import ContactsPage from './pages/Contacts';
import TemplatesPage from './pages/Templates';
import SequencesPage from './pages/Sequences';
import SequenceEditorPage from './pages/SequenceEditor';
import RulesPage from './pages/Rules';
import ReviewPage from './pages/Review';
import SettingsPage from './pages/Settings';
import AdminSettingsPage from './pages/AdminSettings';
import HomePage from './pages/Home';
import { Spinner } from './components/ui';

function Gate() {
  const { user, loading, needsSetup } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="center" style={{ height: '100vh' }}><Spinner size={26} /></div>;
  if (needsSetup) return loc.pathname === '/setup' ? <SetupPage /> : <Navigate to="/setup" replace />;
  if (!user) return loc.pathname === '/login' ? <LoginPage /> : loc.pathname === '/register' ? <RegisterPage /> : <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (loc.pathname === '/login' || loc.pathname === '/setup' || loc.pathname === '/register') return <Navigate to="/mail/inbox" replace />;
  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Navigate to="/mail/inbox" replace />} />
        <Route path="/home" element={<HomePage />} />
        <Route path="/mail/:box" element={<MailPage />} />
        <Route path="/mail/:box/t/:threadKey" element={<MailPage />} />
        <Route path="/contacts" element={<ContactsPage />} />
        <Route path="/contacts/:id" element={<ContactsPage />} />
        <Route path="/templates" element={<TemplatesPage />} />
        <Route path="/sequences" element={<SequencesPage />} />
        <Route path="/sequences/:id" element={<SequenceEditorPage />} />
        <Route path="/rules" element={<RulesPage />} />
        <Route path="/responders" element={<RespondersPage />} />
        <Route path="/review" element={<ReviewPage />} />
        <Route path="/settings/*" element={<SettingsPage />} />
        <Route path="/admin/*" element={<AdminSettingsPage />} />
        <Route path="*" element={<Navigate to="/mail/inbox" replace />} />
      </Routes>
    </Shell>
  );
}

export default function App() {
  return (
    <ToastProvider>
      <AuthProvider>
        <PgpProvider>
          <ComposeProvider>
            <Gate />
          </ComposeProvider>
        </PgpProvider>
      </AuthProvider>
    </ToastProvider>
  );
}
