import { ReferenceEngine } from '../../model/reference-engine.ts'
import { describeMatchingEngine } from './conformance.ts'

describeMatchingEngine('ReferenceEngine', () => new ReferenceEngine())
