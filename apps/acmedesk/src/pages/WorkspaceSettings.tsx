import { useState, type FormEvent } from 'react';
import { PageHeader } from '../components/PageHeader';
import { StatusMessage } from '../components/StatusMessage';
import { TIMEZONES } from '../data/seed';
import { useWorkspace } from '../state/workspace';

export function WorkspaceSettings() {
  const { workspace, saveWorkspace } = useWorkspace();
  const [name, setName] = useState(workspace.name);
  const [timezone, setTimezone] = useState(workspace.timezone);
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState('');

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Workspace name is required.');
      setConfirmation('');
      return;
    }
    saveWorkspace({ name: trimmed, timezone });
    setName(trimmed);
    setError('');
    setConfirmation('Workspace settings saved.');
  }

  return (
    <>
      <PageHeader title="Workspace Settings" description="General settings for this workspace." />

      <StatusMessage testId="workspace-status">{confirmation}</StatusMessage>

      <form className="card form" onSubmit={handleSubmit} aria-label="Workspace settings" noValidate>
        <h2>General</h2>
        <label htmlFor="workspace-name">Workspace name</label>
        <input
          id="workspace-name"
          name="workspaceName"
          value={name}
          onChange={(e) => setName(e.target.value)}
          autoComplete="off"
          maxLength={80}
        />
        <label htmlFor="workspace-timezone">Timezone</label>
        <select id="workspace-timezone" name="timezone" value={timezone} onChange={(e) => setTimezone(e.target.value)}>
          {TIMEZONES.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
        <StatusMessage testId="workspace-error" tone="error">{error}</StatusMessage>
        <div className="form-actions">
          <button type="submit" className="btn btn-primary">Save changes</button>
        </div>
      </form>
    </>
  );
}
