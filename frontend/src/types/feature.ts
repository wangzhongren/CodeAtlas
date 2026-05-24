export interface FeatureNode {
  id: string;
  label: string;
  level: number;
  parent_id: string | null;
  description: string;
  flow_description: string;
  files: string[];
  functions: string[];
  children: FeatureNode[];
  generated: boolean;
}
