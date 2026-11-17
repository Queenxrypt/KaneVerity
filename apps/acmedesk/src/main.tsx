import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { App } from './App';
import { WorkspaceProvider } from './state/workspace';
import { Dashboard } from './pages/Dashboard';
import { Projects } from './pages/Projects';
import { TeamMembers } from './pages/TeamMembers';
import { WorkspaceSettings } from './pages/WorkspaceSettings';
import { DeveloperSettings } from './pages/DeveloperSettings';
import { ApiKeys } from './pages/ApiKeys';
import { NotFound } from './pages/NotFound';
import './styles.css';

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'projects', element: <Projects /> },
      { path: 'team', element: <TeamMembers /> },
      { path: 'workspace-settings', element: <WorkspaceSettings /> },
      { path: 'developer', element: <DeveloperSettings /> },
      { path: 'developer/api-keys', element: <ApiKeys /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <WorkspaceProvider>
      <RouterProvider router={router} />
    </WorkspaceProvider>
  </StrictMode>,
);
