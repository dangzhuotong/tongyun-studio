import ToolPanel from './ToolPanel';
import type { ComponentProps } from 'react';
export default function GitPanel(props: Omit<ComponentProps<typeof ToolPanel>, 'toolId'>) { return <ToolPanel {...props} toolId="git"/>; }
