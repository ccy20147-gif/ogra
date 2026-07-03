import { DataClassification } from '../shared/types';

/**
 * High-Water Mark computation service.
 *
 * When assembling context, the run classification MUST become
 * the highest classification among workspace, KB, docs, chunks,
 * memories, tool outputs, and agent manifest risk.
 */
export class HighWaterMarkService {
  /**
   * Classification priority order (index = priority).
   * Higher index = higher sensitivity.
   */
  private readonly classificationOrder: Record<string, number> = {
    [DataClassification.Public]: 0,
    [DataClassification.Internal]: 1,
    [DataClassification.Confidential]: 2,
    [DataClassification.Restricted]: 3,
  };

  /**
   * Compute the high-water classification from multiple sources.
   * Returns the highest classification and the sources that caused it.
   */
  compute(sources: Array<{
    sourceType: string;
    sourceId: string;
    classification: string;
  }>): {
    highWaterMark: string;
    highWaterSources: string[];
    classificationLevel: number;
  } {
    let maxLevel = -1;
    let maxClassification: string = DataClassification.Internal; // Default
    const highWaterSources: string[] = [];

    for (const source of sources) {
      const level = this.classificationOrder[source.classification] ?? -1;
      if (level > maxLevel) {
        maxLevel = level;
        maxClassification = source.classification;
        highWaterSources.length = 0;
        highWaterSources.push(source.sourceId);
      } else if (level === maxLevel) {
        highWaterSources.push(source.sourceId);
      }
    }

    // Unknown classification -> at least Internal
    if (maxLevel < 0) {
      maxClassification = DataClassification.Internal;
    }

    return {
      highWaterMark: maxClassification as DataClassification,
      highWaterSources,
      classificationLevel: maxLevel < 0 ? 1 : maxLevel,
    };
  }

  /**
   * Check if a given classification allows cloud compute.
   */
  isCloudAllowed(classification: string, strictMode: 'alpha' | 'beta' = 'alpha'): boolean {
    if (strictMode === 'alpha') {
      // Alpha: only Public allows cloud
      return classification === DataClassification.Public;
    }
    // Beta: Internal may allow cloud with redaction/approval
    return classification === DataClassification.Public ||
           classification === DataClassification.Internal;
  }
}
