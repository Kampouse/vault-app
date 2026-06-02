import { WalletProvider } from './contexts/WalletContext';
import VaultPage from './pages/VaultPage';
import './index.css';

function App() {
  return (
    <WalletProvider>
      <VaultPage />
    </WalletProvider>
  );
}

export default App;
