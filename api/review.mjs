import {handleReview} from '../lib/imaging-review.mjs';
export default function handler(req,res){
 res.setHeader('Cache-Control','no-store');
 return handleReview(req,{hosted:true,send:(status,body)=>res.status(status).json(body)});
}
