import { Outlet } from 'react-router-dom';
import { Sidebar } from './components/Sidebar';

export function App() {
  return (
    <div className="layout">
      <Sidebar />
      <main className="content" id="main-content">
        <Outlet />
      </main>
    </div>
  );
}
