import ToolPanel from './ToolPanel';
import type { ComponentProps } from 'react';
export default function DatabasePanel(props: Omit<ComponentProps<typeof ToolPanel>, 'toolId'>) { return <ToolPanel {...props} toolId="database"/>; }
