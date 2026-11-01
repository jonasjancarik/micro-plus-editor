// What the page needs to know about the amp's models and settings. Kept in server/ until Python goes.
import models from '../../server/mmp_models.json';
import parameterChoices from '../../server/mmp_parameter_choices.json';
import unscaled from '../../server/mmp_parameter_hints.json';

export const MODELS = models as Record<string, { id: string; name: string }[]>;
export const PARAMETER_CHOICES: unknown = parameterChoices;
export const UNSCALED: unknown = unscaled;
