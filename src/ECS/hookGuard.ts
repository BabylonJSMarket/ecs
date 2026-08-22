/**
 * Hook guard — catches the single most common Arcade ECS mistake: writing a
 * System hook on a Component, or a Component hook on a System.
 *
 * Both halves of a component live in one file and read alike, so it is easy to
 * put `onUpdate` on the data class or `onAttachOverride` on the logic class.
 * Neither is an error to TypeScript — the method is simply never called, and
 * the feature silently does nothing. This turns that silence into a console
 * warning the first time the class is constructed.
 */

/** Methods only the World ever calls on a System. Dead weight on a Component. */
const SYSTEM_ONLY_HOOKS = [
  'onUpdate',
  'onInitialize',
  'onShutdown',
  'onEntityAdded',
  'onEntityRemoved',
] as const;

/** Methods only an Entity ever calls on a Component. Dead weight on a System. */
const COMPONENT_ONLY_HOOKS = [
  'onAttach',
  'onDetach',
  'onAttachOverride',
  'onDetachOverride',
] as const;

/** Classes already reported, so a pooled entity can't spam the console. */
const warned = new Set<unknown>();

let enabled = true;

/**
 * Turn the hook guard off (or back on) process-wide.
 *
 * Off by choice, not by accident: the check runs once per class, not per
 * instance, so leaving it on costs a Set lookup per construction.
 */
export function setHookGuardEnabled(value: boolean): void {
  enabled = value;
}

/** Forget which classes have been warned about. Test-support only. */
export function resetHookGuard(): void {
  warned.clear();
}

/**
 * Collect every method name a subclass declares between its own prototype and
 * `basePrototype` (exclusive), so the base class's own hooks never self-report.
 */
function subclassMethodNames(instance: object, basePrototype: object): Set<string> {
  const names = new Set<string>();
  let proto = Object.getPrototypeOf(instance);
  while (proto && proto !== basePrototype && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name !== 'constructor') names.add(name);
    }
    proto = Object.getPrototypeOf(proto);
  }
  return names;
}

/**
 * Warn if `instance` declares hooks that belong to the other half of the pair.
 *
 * @param instance - The freshly constructed Component or System
 * @param basePrototype - `Component.prototype` / `System.prototype`, the stop
 *   point for the prototype walk
 * @param kind - What the instance is ("Component" / "System")
 * @param otherKind - Where the offending hooks actually belong
 * @param foreignHooks - Hook names owned by `otherKind`
 * @param advice - The one-line fix, appended to the warning
 */
function warnOnForeignHooks(
  instance: object,
  basePrototype: object,
  kind: string,
  otherKind: string,
  foreignHooks: readonly string[],
  advice: string,
): void {
  if (!enabled) return;

  const ctor = instance.constructor;
  if (warned.has(ctor)) return;
  warned.add(ctor);

  const declared = subclassMethodNames(instance, basePrototype);
  const offenders = foreignHooks.filter(hook => declared.has(hook));
  if (offenders.length === 0) return;

  // ASCII only, and one flat line: this lands in a terminal as often as a
  // browser console.
  const list = offenders.map(hook => `${hook}()`).join(', ');
  const one = offenders.length === 1;
  console.warn(
    `[ECS] ${(ctor as { name?: string }).name ?? kind} extends ${kind} but defines ` +
      `the ${otherKind} ${one ? 'hook' : 'hooks'} ${list}. ` +
      `Nothing will call ${one ? 'it' : 'them'} on a ${kind}. ${advice}`,
  );
}

/** Called from the Component constructor. */
export function guardComponentHooks(instance: object, basePrototype: object): void {
  warnOnForeignHooks(
    instance,
    basePrototype,
    'Component',
    'System',
    SYSTEM_ONLY_HOOKS,
    'Move that logic to the matching System, or use onAttachOverride()/onDetachOverride() if it is per-entity setup.',
  );
}

/** Called from the System constructor. */
export function guardSystemHooks(instance: object, basePrototype: object): void {
  warnOnForeignHooks(
    instance,
    basePrototype,
    'System',
    'Component',
    COMPONENT_ONLY_HOOKS,
    'Systems react to entities with onEntityAdded()/onEntityRemoved(), and set up in onInitialize().',
  );
}
