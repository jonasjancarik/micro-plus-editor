// What the page needs to know about the amp's models and settings.
import models from '../data/models.json';
import parameterChoices from '../data/parameter_choices.json';
import unscaled from '../data/parameter_hints.json';

export const MODELS = models as Record<string, { id: string; name: string }[]>;
export const PARAMETER_CHOICES: unknown = parameterChoices;
export const UNSCALED: unknown = unscaled;
