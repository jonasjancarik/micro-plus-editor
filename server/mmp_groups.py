"""Keep what the amp has nowhere to store on this computer: preset groups, and which presets were saved over."""
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


def read_state(path, empty, valid):
    if not path or not path.exists():
        return empty
    try:
        state = json.loads(path.read_text(encoding='utf-8'))
        if not valid(state):
            raise ValueError('Unexpected contents')
        return state
    except (ValueError, KeyError, TypeError) as error:
        print(f'Could not read {path}, so it was set aside: {error!r}', file=sys.stderr, flush=True)
        os.replace(path, path.with_name(path.name + '.unreadable'))
        return empty


def write_state(path, state):
    if not path:
        return
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.tmp')
    with temporary.open('w', encoding='utf-8') as stream:
        json.dump(state, stream, indent=2)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, path)


class SavedPresets:
    """Remembers the name each slot had when it was seen to be saved over, so a built-in can be shown as edited.

    The amp can't be relied on for this: a save in place can leave its factory flag set.
    The name is kept because something else may later be saved to the slot without this page seeing it.
    """

    def __init__(self, path=None):
        self.path = Path(path) if path else None
        self.state = read_state(self.path, {}, lambda state: isinstance(state, dict))

    def set(self, slot, name):
        slot = str(slot)
        if self.state.get(slot) == name:
            return
        state = {key: value for key, value in self.state.items() if key != slot}
        if name is not None:
            state[slot] = name
        self.state = state
        try:
            write_state(self.path, state)
        except OSError as error:  # Only a label depends on this, so it mustn't get in the way of a save.
            print(f'Could not remember the saved preset: {error!r}', file=sys.stderr, flush=True)


class PresetGroups:
    """Groups are names, and assignments say which group a preset slot was moved to.

    A slot can also be moved to a group the page provides, which this class doesn't know about.
    """

    def __init__(self, path=None):
        self.path = Path(path) if path else None  # Without a path, groups last until the server stops.
        self.state = self.load()

    def load(self):
        return read_state(self.path, {'groups': [], 'assignments': {}},
                          lambda state: isinstance(state['groups'], list) and isinstance(state['assignments'], dict))

    def write(self, state):
        try:
            write_state(self.path, state)
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
