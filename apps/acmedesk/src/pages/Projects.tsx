import { useState, type FormEvent } from 'react';
import { PageHeader } from '../components/PageHeader';
import { StatusMessage } from '../components/StatusMessage';
import { useWorkspace } from '../state/workspace';

export function Projects() {
  const { projects, createProject } = useWorkspace();
  const [formOpen, setFormOpen] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [confirmation, setConfirmation] = useState('');

  function handleSubmit(event: FormEvent) {
    event.preventDefault();
    const trimmed = name.trim();
    if (!trimmed) {
      setError('Project name is required.');
      return;
    }
    if (projects.some((p) => p.name.toLowerCase() === trimmed.toLowerCase())) {
      setError(`A project named "${trimmed}" already exists.`);
      return;
    }
    const project = createProject(trimmed);
    setError('');
    setName('');
    setFormOpen(false);
    setConfirmation(`Project "${project.name}" created.`);
  }

  return (
    <>
      <PageHeader
        title="Projects"
        description="Projects in this workspace."
        actions={
          !formOpen && (
            <button type="button" className="btn btn-primary" onClick={() => setFormOpen(true)}>
              New project
            </button>
          )
        }
      />

      <StatusMessage testId="project-status">{confirmation}</StatusMessage>

      {formOpen && (
        <form className="card form" onSubmit={handleSubmit} aria-label="New project" noValidate>
          <h2>New project</h2>
          <label htmlFor="project-name">Project name</label>
          <input
            id="project-name"
            name="projectName"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="off"
            maxLength={80}
          />
          <StatusMessage testId="project-error" tone="error">{error}</StatusMessage>
          <div className="form-actions">
            <button type="submit" className="btn btn-primary">Create project</button>
            <button
              type="button"
              className="btn"
              onClick={() => {
                setFormOpen(false);
                setError('');
                setName('');
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <table className="table" aria-label="Projects list">
        <thead>
          <tr>
            <th scope="col">Name</th>
            <th scope="col">Status</th>
            <th scope="col">Owner</th>
          </tr>
        </thead>
        <tbody>
          {projects.map((p) => (
            <tr key={p.id}>
              <td>{p.name}</td>
              <td>{p.status}</td>
              <td>{p.owner}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
