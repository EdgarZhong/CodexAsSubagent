import {
  DEFAULT_EFFORT,
  DEFAULT_MODEL,
} from '../shared/constants.mjs';
import {
  DefaultModelUnavailableError,
  InvalidEffortError,
  InvalidModelError,
} from '../shared/errors.mjs';

function stringValue(...values) {
  return values.find((value) => typeof value === 'string' && value.length > 0) ?? null;
}

function configObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value.effectiveConfig ?? value.config ?? value;
}

function effortList(entry) {
  const value = entry?.supportedReasoningEfforts
    ?? entry?.supportedEfforts
    ?? entry?.reasoningEfforts
    ?? entry?.efforts;
  if (Array.isArray(value)) {
    return value.filter((effort) => typeof effort === 'string');
  }
  return [];
}

function normalizeModels(value) {
  const models = Array.isArray(value)
    ? value
    : Array.isArray(value?.models)
      ? value.models
      : Array.isArray(value?.data)
        ? value.data
        : [];
  return models
    .map((entry) => {
      if (typeof entry === 'string') return { id: entry, efforts: [] };
      if (!entry || typeof entry !== 'object') return null;
      const id = stringValue(entry.id, entry.model, entry.slug, entry.name);
      return id ? { ...entry, id, efforts: effortList(entry) } : null;
    })
    .filter(Boolean);
}

export class ModelService {
  constructor({ adapter = null, models = null, effectiveConfig = null } = {}) {
    this.adapter = adapter;
    this.models = models;
    this.effectiveConfig = effectiveConfig;
  }

  async #availableModels() {
    if (this.models !== null && this.models !== undefined) {
      return normalizeModels(this.models);
    }
    if (!this.adapter?.listModels) {
      return [];
    }
    return normalizeModels(await this.adapter.listModels());
  }

  async #config() {
    if (this.effectiveConfig !== null && this.effectiveConfig !== undefined) {
      return this.effectiveConfig;
    }
    if (!this.adapter?.readEffectiveConfig) {
      return {};
    }
    return await this.adapter.readEffectiveConfig();
  }

  async resolveSpawn(model = undefined, effort = undefined) {
    if (model !== undefined && (typeof model !== 'string' || model.length === 0)) {
      throw new InvalidModelError('Model must be a non-empty string.');
    }
    if (effort !== undefined && (typeof effort !== 'string' || effort.length === 0)) {
      throw new InvalidEffortError('Effort must be a non-empty string.');
    }

    const models = await this.#availableModels();
    const config = configObject(await this.#config());
    const configuredModel = stringValue(config.model, config.defaultModel, config.default_model);
    const selectedModel = model ?? configuredModel ?? DEFAULT_MODEL;

    if (models.length === 0) {
      if (model === undefined) {
        throw new DefaultModelUnavailableError('No verifiable model catalog is available for the default spawn.');
      }
      throw new InvalidModelError(`Model ${model} is not verifiably available on this supervisor.`);
    }
    const entry = models.find((candidate) => candidate.id === selectedModel);

    if (model === undefined && models.length > 0 && !entry) {
      throw new DefaultModelUnavailableError(
        `Default model ${DEFAULT_MODEL} is not available on this supervisor.`,
      );
    }
    if (model !== undefined && models.length > 0 && !entry) {
      throw new InvalidModelError(`Model ${model} is not available on this supervisor.`);
    }

    const availableEfforts = entry?.efforts ?? [];
    const configuredEffort = stringValue(
      config.model_reasoning_effort,
      config.modelReasoningEffort,
      config.effort,
      config.defaultEffort,
      config.default_effort,
    );
    let selectedEffort = effort ?? (model === undefined ? configuredEffort ?? DEFAULT_EFFORT : null);
    if (selectedEffort === null) {
      selectedEffort = stringValue(entry?.defaultEffort, configuredEffort, DEFAULT_EFFORT);
      if (availableEfforts.length > 0 && !availableEfforts.includes(selectedEffort)) {
        selectedEffort = availableEfforts[0];
      }
    }

    if (availableEfforts.length > 0 && !availableEfforts.includes(selectedEffort)) {
      throw new InvalidEffortError(
        `Effort ${selectedEffort} is not supported by model ${selectedModel}.`,
      );
    }
    return { model: selectedModel, effort: selectedEffort };
  }

  static async resolveSpawn(model = undefined, effort = undefined, options = {}) {
    return await new ModelService(options).resolveSpawn(model, effort);
  }
}

export async function resolveSpawn(model = undefined, effort = undefined, options = {}) {
  return await ModelService.resolveSpawn(model, effort, options);
}
