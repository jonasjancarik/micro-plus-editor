/** The request or the data is wrong, so nothing is known to have reached the amp. */
export class InputError extends Error {}

/** The page's view of the preset is out of date. */
export class EditorConflict extends InputError {}

/** The amp didn't do what was asked, or may have. */
export class AmpError extends Error {}

/** A backup couldn't be made or read, so nothing was written to the amp. */
export class BackupError extends Error {}
