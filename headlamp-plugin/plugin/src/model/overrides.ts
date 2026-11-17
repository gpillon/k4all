/*
 * The component overrides form: Helm values as YAML text plus one --set
 * argument per line, to and from ClusterConfig.spec.componentOverrides[name].
 */

import { jsonEqual } from './objects';
import { toYaml } from './textDiff';
import { ComponentOverride } from './types';
import { Issue, overrideWarnings, parseValuesYaml, validateHelmArg } from './validation';

export interface OverrideForm {
  valuesText: string;
  argsText: string;
}

export function formFromOverride(override: ComponentOverride | undefined): OverrideForm {
  const values = override?.values;
  return {
    valuesText: values && Object.keys(values).length ? toYaml(values, false) : '',
    argsText: (override?.helmArgs ?? []).join('\n'),
  };
}

export interface ParsedOverrideForm {
  override?: ComponentOverride;
  issues: Issue[];
}

export function parseOverrideForm(
  component: string,
  componentType: string,
  form: OverrideForm
): ParsedOverrideForm {
  const field = `override:${component}`;
  const issues: Issue[] = [];
  const parsed = parseValuesYaml(form.valuesText);
  if (parsed.error) {
    issues.push({ field: `${field}:values`, severity: 'error', message: parsed.error });
  }
  const helmArgs = form.argsText
    .split('\n')
    .map(l => l.trim())
    .filter(l => l !== '' && !l.startsWith('#'));
  helmArgs.forEach((arg, i) => {
    const problem = validateHelmArg(arg);
    if (problem) {
      issues.push({
        field: `${field}:args`,
        severity: 'error',
        message: `Line ${i + 1}: ${problem}`,
      });
    }
  });
  if (componentType !== 'helm' && componentType !== 'helm-oci' && helmArgs.length > 0) {
    issues.push({
      field: `${field}:args`,
      severity: 'warning',
      message: 'helmArgs only apply to Helm components.',
    });
  }
  issues.push(...overrideWarnings(component, parsed.values, componentType));
  if (issues.some(i => i.severity === 'error')) {
    return { issues };
  }
  const override: ComponentOverride = {};
  if (parsed.values) {
    override.values = parsed.values;
  }
  if (helmArgs.length) {
    override.helmArgs = helmArgs;
  }
  return { override, issues };
}

/** Whether the form means something different from the stored override. */
export function overrideChanged(
  stored: ComponentOverride | undefined,
  parsed: ComponentOverride | undefined
): boolean {
  const norm = (o: ComponentOverride | undefined) => ({
    values: o?.values && Object.keys(o.values).length ? o.values : undefined,
    helmArgs: o?.helmArgs && o.helmArgs.length ? o.helmArgs : undefined,
  });
  return !jsonEqual(norm(stored), norm(parsed));
}

/**
 * The form to show once the stored override changed from `previous` to
 * `next`: a form without local edits (equal to `previous`), or one that
 * already says what was just saved (equal to `next`), follows the server;
 * a form with other edits is kept.
 */
export function followStored(
  form: OverrideForm,
  previous: ComponentOverride | undefined,
  next: ComponentOverride | undefined,
  component: string,
  componentType: string
): OverrideForm {
  const parsed = parseOverrideForm(component, componentType, form).override;
  const clean =
    parsed !== undefined && (!overrideChanged(previous, parsed) || !overrideChanged(next, parsed));
  return clean ? formFromOverride(next) : form;
}
