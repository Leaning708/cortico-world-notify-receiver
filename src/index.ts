/** 包入口：默认导出 `WorldDefinition`，加载器按 `cortico.kind === 'world'` 认它。 */
import { NOTIFY_RECEIVER } from './definition.ts';

export default NOTIFY_RECEIVER;
export { NOTIFY_RECEIVER };
export type { NotifyReceiverConfigSection } from './config.ts';
