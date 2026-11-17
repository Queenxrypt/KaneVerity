import { useState, type FormEvent } from 'react';
import { PageHeader } from '../components/PageHeader';
import { StatusMessage } from '../components/StatusMessage';
import { ROLES, type Role } from '../data/seed';
import { useWorkspace } from '../state/workspace';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function TeamMembers() {
  const { members, inviteMember } = useWorkspace();
  const [formOpen, setFormOpen] = useState(false);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('Member');
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState('');

  function resetForm() {
    setEmail('');
    setRole('Member');
    setError('');
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = email.trim().toLowerCase();
    if (!trimmed) {
      setError('Email address is required.');
      return;
    }
    if (!EMAIL_PATTERN.test(trimmed)) {
      setError('Enter a valid email address.');
      return;
    }
    if (members.some((m) => m.email === trimmed)) {
      setError(`${trimmed} is already a member of this workspace.`);
      return;
    }
    const member = inviteMember(trimmed, role);
    resetForm();
    setFormOpen(false);
    setConfirmation(`Invitation sent to ${member.email} as ${member.role}.`);
  }

  return (
    <>
      <PageHeader
        title="Team Members"
        description="People who can access this workspace. Invitations are simulated; no email is sent."
        actions={
          !formOpen && (
            <button type="button" className="btn btn-primary" onClick={() => setFormOpen(true)}>
              Invite member
            </button>
          )
        }
      />

      <StatusMessage testId="invite-status">{confirmation}</StatusMessage>

      {formOpen && (
        <form className="card form" onSubmit={handleSubmit} aria-label="Invite member" noValidate>
          <h2>Invite member</h2>
          <label htmlFor="invite-email">Email address</label>
          <input
            id="invite-email"
            name="email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="off"
          />
          <label htmlFor="invite-role">Role</label>
          <select id="invite-role" name="role" value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {ROLES.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          <StatusMessage testId="invite-error" tone="error">{error}</StatusMessage>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary">Send invite</button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                resetForm();
                setFormOpen(false);
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <table className="table" aria-label="Team members list">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Email</th>
            <th scope="col">Role</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {members.map((m) => (
            <tr key={m.id}>
              <td>{m.name}</td>
              <td>{m.email}</td>
              <td>{m.role}</td>
              <td>{m.status}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
