import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider } from 'react-router-dom';
import { App } from './App.tsx';
import { HealthProvider } from './health.tsx';
import { Dashboard } from './pages/Dashboard.tsx';
import { Connect } from './pages/Connect.tsx';
import { Tutorials } from './pages/Tutorials.tsx';
import { RunDetail } from './pages/RunDetail.tsx';
import { Corrections } from './pages/Corrections.tsx';
import { CorrectionDetail } from './pages/CorrectionDetail.tsx';
import { NotFound } from './pages/NotFound.tsx';
import './styles.css';

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'connect', element: <Connect /> },
      { path: 'tutorials', element: <Tutorials /> },
      { path: 'runs/:runId', element: <RunDetail /> },
      { path: 'corrections', element: <Corrections /> },
      { path: 'corrections/:id', element: <CorrectionDetail /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HealthProvider>
      <RouterProvider router={router} />
    </HealthProvider>
  </StrictMode>,
);
