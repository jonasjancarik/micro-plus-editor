// Turns the page's requests into session calls. The requests keep the shape the earlier Python server took.
import { InputError } from './errors';
import { CHOOSE_EQ, type EditorSession, type SavedDocument, type Snapshot } from './session';

const hasOnly = (request: Record<string, unknown>, ...keys: string[]) => {
  const present = Object.keys(request);
  return present.length === keys.length && keys.every((key) => present.includes(key));
};

export async function dispatch(session: EditorSession, path: string, body: unknown): Promise<Snapshot | SavedDocument> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw new InputError('Send an object describing the change.');
  const request = body as Record<string, unknown>;
  if (path === '/api/micro-plus') {
    if (!hasOnly(request, 'preset')) throw new InputError('Choose a preset number from 1 to 100.');
    return session.switch(request.preset);
  }
  if (path === '/api/micro-plus/eq') {
    if (!hasOnly(request, 'eq')) throw new InputError(CHOOSE_EQ);
    return session.setEq(request.eq);
  }
  if (path === '/api/micro-plus/groups') return session.changeGroups(request);
  if (path === '/api/micro-plus/compare') return session.changeCompare(request);
  if (path !== '/api/micro-plus/editor') throw new InputError('Page not found.');
  const { action, preset, revision } = request;
  const common = ['action', 'preset', 'revision'];
  if (action === 'parameter' && hasOnly(request, ...common, 'node', 'parameter', 'value')) {
    return session.edit(preset, revision, request.node, request.parameter, request.value);
  }
  if (action === 'model' && hasOnly(request, ...common, 'node', 'model')) return session.replace(preset, revision, request.node, request.model);
  if (action === 'order' && hasOnly(request, ...common, 'order')) return session.setOrder(preset, revision, request.order);
  if (action === 'save' && hasOnly(request, ...common, 'target', 'name')) return session.save(preset, revision, request.target, request.name);
  if (action === 'undo-save' && hasOnly(request, ...common)) return session.undoSave(preset, revision);
  if (action === 'saved-copy' && hasOnly(request, ...common)) return session.savedCopy(preset, revision);
  if (action === 'read-slot' && hasOnly(request, 'action', 'slot')) return session.readSlot(request.slot);
  if (action === 'import' && hasOnly(request, ...common, 'target', 'name', 'document')) {
    return session.importPreset(preset, revision, request.target, request.name, request.document);
  }
  throw new InputError('Choose a parameter, model, save or undo operation.');
}
