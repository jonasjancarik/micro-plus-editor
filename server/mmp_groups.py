"""Keep the preset groups people make on this computer, because the amp has nowhere to store them."""
import copy
import json
import os
import sys
from pathlib import Path

MAX_GROUPS = 50
MAX_NAME = 24


def clean_name(name):
    if not isinstance(name, str) or not name.strip():
        raise ValueError('Enter a name for the group.')
    name = name.strip()
    if len(name) > MAX_NAME:
        raise ValueError(f'Keep group names to {MAX_NAME} characters.')
    return name


class PresetGroups:
    """Groups are names, and assignments say which group a preset slot was moved to.

    A slot can also be moved to a group the page provides, which this class doesn't know about.
    """

    def __init__(self, path=None):
        self.path = Path(path) if path else None  # Without a path, groups last until the server stops.
        self.state = self.load()

    def load(self):
        empty = {'groups': [], 'assignments': {}}
        if not self.path or not self.path.exists():
            return empty
        try:
            state = json.loads(self.path.read_text(encoding='utf-8'))
            if not (isinstance(state['groups'], list) and isinstance(state['assignments'], dict)):
                raise ValueError('Unexpected contents')
            return state
        except (ValueError, KeyError, TypeError) as error:
            print(f'Could not read {self.path}, so it was set aside: {error!r}', file=sys.stderr, flush=True)
            os.replace(self.path, self.path.with_name(self.path.name + '.unreadable'))
            return empty

    def write(self, state):
        if not self.path:
            return
        try:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            temporary = self.path.with_name(self.path.name + '.tmp')
            with temporary.open('w', encoding='utf-8') as stream:
                json.dump(state, stream, indent=2)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.path)
        except OSError as error:
            raise RuntimeError('Could not save your groups on this computer.') from error

    @staticmethod
    def require_new(state, name, ignoring=None):
        taken = {group.casefold() for group in state['groups'] if group != ignoring}
        if name.casefold() in taken:
            raise ValueError(f'There is already a group called “{name}”.')

    def apply(self, request):
        state = copy.deepcopy(self.state)
        action = request.get('action')
        if action == 'create' and set(request) == {'action', 'name'}:
            name = clean_name(request['name'])
            self.require_new(state, name)
            if len(state['groups']) >= MAX_GROUPS:
                raise ValueError(f'You can have up to {MAX_GROUPS} groups.')
            state['groups'].append(name)
        elif action == 'rename' and set(request) == {'action', 'name', 'new_name'}:
            if request['name'] not in state['groups']:
                raise ValueError('That group no longer exists.')
            name = clean_name(request['new_name'])
            self.require_new(state, name, ignoring=request['name'])
            state['groups'][state['groups'].index(request['name'])] = name
            state['assignments'] = {slot: name if group == request['name'] else group
                                    for slot, group in state['assignments'].items()}
        elif action == 'delete' and set(request) == {'action', 'name'}:
            if request['name'] not in state['groups']:
                raise ValueError('That group no longer exists.')
            state['groups'].remove(request['name'])
            state['assignments'] = {slot: group for slot, group in state['assignments'].items()
                                    if group != request['name']}
        elif action == 'move' and set(request) == {'action', 'preset', 'group'}:
            if type(request['preset']) is not int or not 1 <= request['preset'] <= 100:
                raise ValueError('Choose a preset number from 1 to 100.')
            if request['group'] is None:  # Back to its usual group.
                state['assignments'].pop(str(request['preset']), None)
            else:
                state['assignments'][str(request['preset'])] = clean_name(request['group'])
        else:
            raise ValueError('Choose a group to create, rename or delete, or a preset to move.')
        self.write(state)
        self.state = state
