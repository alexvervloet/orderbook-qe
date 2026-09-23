import { ProductionMatchingEngine } from '../../../sut/backend/engine/matching-engine.ts'
import { describeMatchingEngine } from './conformance.ts'

describeMatchingEngine('ProductionMatchingEngine', () => new ProductionMatchingEngine())
