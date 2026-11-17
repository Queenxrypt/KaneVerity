import { useEffect } from 'react';
import { Card } from '../components/ui.tsx';

export function Corrections() {
  useEffect(() => {
    document.title = 'Corrections · KaneVerity';
  }, []);
  return (
    <div className="space-y-5">
      <h1 className="text-2xl font-bold">Corrections</h1>
      <Card>
        <p className="text-sm text-slate-600">
          Claude-assisted documentation corrections arrive in Step 5. A confirmed documentation finding will be sent to Claude Code with its sanitized Kane evidence. You review and approve the proposed change, and Kane retests it independently.
        </p>
      </Card>
    </div>
  );
}
